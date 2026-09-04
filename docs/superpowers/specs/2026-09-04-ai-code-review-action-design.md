# AI Code Review Action — Design

Date: 2026-09-04
Status: Approved (brainstorming session with all design sections signed off)

## Purpose

A public GitHub Action that runs AI-powered code review on pull requests and posts findings as **inline comments** on the exact diff lines, plus one **summary review comment**. Configurable across multiple AI providers.

## Goals

- High-signal review: bugs, security issues, logic errors, performance problems — severity-tagged
- Inline comments anchored to specific diff lines via a single PR review
- Multi-provider support with a uniform configuration surface
- Publishable on the GitHub Marketplace with tagged releases

## Non-goals (v1)

- Local CLI / npm package distribution
- Multi-file chunked review of huge PRs beyond model context (whole-diff single call, with a truncation safety valve instead)
- Replying to human comments, review approvals, or merge gating
- Self-hosted model orchestration

## Decisions

| Decision | Choice |
|---|---|
| Runtime | TypeScript, `runs.using: node20`, bundled with `@vercel/ncc`, `dist/index.js` committed |
| Providers | Multi-provider: OpenAI, Anthropic, z.ai, Kimi, plus generic OpenAI-compatible `custom` |
| Triggers | PR lifecycle: `opened`, `synchronize`, `ready_for_review`, `reopened` |
| Output | Inline comments + summary review body |
| Diff strategy | Whole diff in one LLM call, with token safety valve |
| Configuration | Workflow inputs (model/secrets) + `.ai-review.yml` in reviewed repo (behavior) |
| Review focus | High-signal default; `thorough` style and custom instructions optional |
| Distribution | Public marketplace, tagged major versions (`v1`) |

## Architecture

```
action.yml                  # action metadata (inputs, outputs, branding)
src/
  main.ts                   # entrypoint — wires the pipeline together
  config.ts                 # merges action inputs + .ai-review.yml
  diff.ts                   # fetch PR files/diff via GitHub API
  prompt.ts                 # system + user prompt builder
  review.ts                 # orchestration: diff → prompt → provider → findings
  comment.ts                # post inline comments + summary, dismiss stale review
  providers/
    types.ts                # Provider interface + Finding types
    openai.ts               # OpenAI adapter (openai SDK)
    anthropic.ts            # Anthropic adapter (@anthropic-ai/sdk)
    openai-compatible.ts    # base-URL adapter: z.ai, Kimi, Ollama, Groq…
    registry.ts             # provider + model presets, factory
__tests__/                  # vitest unit tests
docs/superpowers/specs/     # design docs
```

Each module has one responsibility; `main.ts` only orchestrates.

## Provider layer

```ts
interface ReviewProvider {
  complete(system: string, user: string): Promise<Finding[]>
}
```

Adapters are pure LLM callers; prompt building lives in the orchestration (`review.ts`) so every adapter shares it.

interface Finding {
  file: string        // path as it appears in the diff
  line: number        // right-side (new) line number
  severity: 'critical' | 'warning' | 'suggestion'
  title: string       // short headline
  body: string        // markdown explanation
}
```

All adapters request **structured JSON output** (OpenAI `response_format: json_schema`; Anthropic tool-use) so findings map reliably to file+line. No free-text parsing.

Adapters and presets:

| `provider` input | Implementation | Default model |
|---|---|---|
| `openai` | `openai` SDK | `gpt-4.1` |
| `anthropic` | `@anthropic-ai/sdk` | `claude-sonnet-4-5` |
| `zai` | OpenAI-compatible adapter | `glm-4.6` |
| `kimi` | OpenAI-compatible adapter | `kimi-k2` |
| `custom` | OpenAI-compatible adapter | required `base-url` + `model` |

z.ai and Kimi presets pre-fill their base URLs; `model` is overridable for every provider. The registry also stores each model's context-window size (used by the token safety valve; `custom` providers must supply `context-window` as an input, defaulting to 128k). Adding a provider later = one adapter file (if not OpenAI-compatible) + one registry entry.

## Pipeline

1. `diff.ts` fetches changed files (patches + line mappings) via `github.rest.pulls.listFiles`
2. Builds a line-numbered, header-annotated diff, applying `paths` / `paths-ignore` filters
3. Token safety valve: if estimated input exceeds ~70% of the model's context window, first skip binary/lock/vendored files, then truncate the diff and state the truncation in the summary — never silently
4. One LLM call returns `Finding[]`; findings referencing files/lines outside the diff are dropped from inline placement and moved to the summary table
5. `comment.ts` posts a single PR review with inline comments and a summary body

## Configuration

`action.yml` inputs (model & wiring live in the workflow):

| Input | Default | Notes |
|---|---|---|
| `provider` | `openai` | `openai` \| `anthropic` \| `zai` \| `kimi` \| `custom` |
| `model` | per-provider preset | e.g. `gpt-4.1`, `glm-4.6`, `kimi-k2` |
| `base-url` | — | required only for `custom` |
| `context-window` | `128000` | tokens; used only by `custom` for the safety valve |
| `github-token` | `${{ github.token }}` | needs `pull-requests: write` |
| `config-path` | `.ai-review.yml` | path in the reviewed repo |

API keys via environment variables — each provider reads only its own: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ZAI_API_KEY`, `KIMI_API_KEY`.

`.ai-review.yml` (in the reviewed repo, all keys optional):

```yaml
paths: ['**/*']                # include globs
paths-ignore: ['**/*.lock', 'dist/**', 'vendor/**']
max-comments: 20               # inline comment cap per run
review-style: high-signal      # high-signal | thorough
severity-threshold: suggestion # minimum severity to post
custom-instructions: |         # appended to the system prompt
  We use Vitest, not Jest. Flag any jest imports.
```

Precedence: action inputs > config file > built-in defaults. Missing config file is valid (pure defaults). Config is validated with zod; invalid config fails the run with an error naming the offending key.

## Comment posting

- All comments posted as **one PR review** (`pulls.createReview`) with inline comments in a single API call — one bot review per push, not scattered comments
- Review body = summary: verdict counts by severity, findings table, model/provider attribution
- Before posting, the bot deletes its own previous inline comments on the PR (tagged with a hidden HTML marker), so findings never pile up across pushes — GitHub's API cannot dismiss `COMMENT`-type reviews
- `max-comments` caps inline comments; overflow findings appear in the summary table with `file:line` links; lowest severities are dropped first
- No findings → short "LGTM" review body, no inline comments

## Error handling

- Invalid JSON from the LLM → one retry with a stricter repair prompt → fail with raw response logged
- Finding anchored outside the diff → downgraded to summary-table entry, never a failed API call
- Provider auth/rate errors → actionable failure message (which key, which provider)
- No partial or broken comments are ever posted

## Testing

- vitest unit tests per module: diff parsing, config merge/validate, prompt building, finding filtering, adapters (SDK calls mocked)
- One integration test of `review.ts` orchestration with a fake provider
- CI on this repo: lint → typecheck → test → `ncc` build → verify `dist/index.js` committed and current

## Future work

- Additional providers (registration is one file + registry entry)
- Optional per-file chunked review for PRs exceeding context even after truncation
- Reply-to-reviewer-feedback loop
