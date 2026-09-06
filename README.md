# AI Code Review Action

AI-powered code review with inline pull request comments for GitHub repositories. This action automatically analyzes pull request diffs using modern LLMs—supporting OpenAI, Anthropic, z.ai, Kimi, and any OpenAI-compatible provider—and posts actionable, severity-ranked findings directly onto the modified code lines alongside an executive summary review.

## How It Works

1. **Diff Extraction & Filtering:** When triggered on pull request events (`opened`, `synchronize`, `reopened`, `ready_for_review`), the action extracts the pull request's changed files and line diffs, applying inclusion and exclusion patterns from repository configuration.
2. **Context Safety Valve:** If the review diff approaches the model's context window limit (~70% threshold), non-essential files are skipped and large diffs are truncated safely, with transparent annotations added to the review summary.
3. **Structured AI Review:** The diff is analyzed in a single unified prompt to the selected AI provider, which returns structured findings categorized by severity (`critical`, `warning`, `suggestion`).
4. **Stale Comment Cleanup:** Before posting new comments, the action identifies and deletes previous inline review comments created by past runs on the PR, avoiding comment clutter across subsequent pushes.
5. **Unified Review Posting:** All comments are submitted as a single pull request review (`pulls.createReview`). Findings matching commentable diff lines are posted as inline annotations. Findings exceeding comment caps or referencing context lines outside the diff are collected in the summary review table. If no issues are identified, a concise "LGTM" review is submitted.

---

## Quick Start

Add the following workflow to your repository under `.github/workflows/ai-code-review.yml`:

```yaml
name: AI Code Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: write
  pull-requests: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: yasserk41/github-ai-codereview-action@v1
        with:
          provider: openai
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

> Note: `contents: write` is required for the thread auto-resolve feature (GitHub's `resolveReviewThread` API demands it). With only `contents: read`, reviews still post normally but resolved findings leave their threads open, with a warning in the run log.

---

## Supported Providers

Each provider reads its API key from a specific environment variable passed to the action step:

| Provider (`provider`) | Default Model | Required Environment Variable | Notes |
|---|---|---|---|
| `openai` | `gpt-4.1` | `OPENAI_API_KEY` | Uses the official OpenAI SDK with strict JSON schema response formats. |
| `anthropic` | `claude-sonnet-4-5` | `ANTHROPIC_API_KEY` | Uses the Anthropic SDK with forced tool-use structured outputs. |
| `zai` | `glm-4.6` | `ZAI_API_KEY` | Pre-configured base URL (`https://api.z.ai/api/paas/v4`) using OpenAI-compatible format. |
| `kimi` | `kimi-k2` | `KIMI_API_KEY` | Pre-configured base URL (`https://api.moonshot.ai/v1`) using OpenAI-compatible format. |
| `custom` | *(none)* | `CUSTOM_API_KEY` | Generic OpenAI-compatible endpoint. Requires `model` and `base-url` inputs. Optional `context-window` input (defaults to `128000`). |

---

## Inputs Reference

The following inputs are defined in `action.yml`:

| Input | Description | Required | Default |
|---|---|---|---|
| `provider` | AI provider: `openai` \| `anthropic` \| `zai` \| `kimi` \| `custom` | No | `'openai'` |
| `model` | Model name (defaults per provider: `gpt-4.1`, `claude-sonnet-4-5`, `glm-4.6`, `kimi-k2`) | No | `''` (uses provider default) |
| `base-url` | Required for provider `"custom"`: OpenAI-compatible base URL | No | `''` |
| `context-window` | Model context window in tokens (custom provider only; others use known values) | No | `''` |
| `github-token` | Token used to read the PR and post the review | No | `${{ github.token }}` |
| `config-path` | Path to the `.ai-review.yml` config file in the reviewed repo | No | `'.ai-review.yml'` |
| `verdict` | Review submission mode: `comment` (always COMMENT) \| `auto` (approve when clean, request changes when severe findings) | No | `'comment'` |
| `request-changes-on` | Minimum severity that triggers REQUEST_CHANGES when verdict is auto: `critical` \| `warning` \| `suggestion` | No | `'critical'` |
| `adjudicate-replies` | Reply to a bot comment and let the AI decide whether the reply resolves the finding | No | `'true'` |

---

## Outputs

| Output | Description |
|---|---|
| `findings-count` | Total findings reported |
| `inline-comments` | Number of inline comments posted |
| `verdict` | Submitted review verdict: `approved` \| `changes-requested` \| `commented` |
| `resolved-threads` | Previous comment threads auto-resolved because their findings vanished |
| `adjudication` | Reply adjudication outcome: `resolved` \| `unresolved` \| `skipped` (only set for `pull_request_review_comment` events) |

---

## Repository Configuration (`.ai-review.yml`)

You can customize the review behavior by adding an optional `.ai-review.yml` file to the root of your repository (or the path specified by `config-path`). All keys are optional; omitting the file uses sensible built-in defaults.

```yaml
paths: ['**/*']                # include globs
paths-ignore: ['**/*.lock', 'dist/**', 'vendor/**']
max-comments: 20               # inline comment cap per run
review-style: high-signal      # high-signal | thorough
severity-threshold: suggestion # minimum severity to post
custom-instructions: |         # appended to the system prompt
  We use Vitest, not Jest. Flag any jest imports.
```

### Configuration Options

- **`paths`** (`string[]`, default: `['**/*']`): Glob patterns of files to include in the review.
- **`paths-ignore`** (`string[]`, default: `[]`): Glob patterns of files to exclude from the review (e.g., lock files, compiled assets, minified bundles).
- **`max-comments`** (`number`, default: `20`): Maximum number of inline comments posted to the PR diff. Comments are prioritized by severity (`critical` first, then `warning`, then `suggestion`). Any findings exceeding this limit are presented in the summary review table.
- **`review-style`** (`'high-signal' | 'thorough'`, default: `'high-signal'`):
  - `high-signal`: Focuses strictly on actionable defects, logic bugs, security vulnerabilities, edge cases, and performance regressions.
  - `thorough`: Includes constructive suggestions, stylistic conventions, and architectural improvements alongside bugs.
- **`severity-threshold`** (`'critical' | 'warning' | 'suggestion'`, default: `'suggestion'`): Filters out any findings lower than this severity level.
- **`custom-instructions`** (`string`, optional): Repository-specific guidelines, coding standards, or domain rules appended directly to the reviewer system prompt.

*Note: The configuration file is strictly validated with Zod. Unrecognized configuration keys will cause the action to fail with an error specifying the invalid key.*

---

## Behavior Notes

- **One review per push:** Findings and verdict summaries are submitted as a single pull request review, keeping PR timelines organized and avoiding noise.
- **Verdicts:** When `verdict` is set to `auto`, the action submits `APPROVE` if no issues are found, `REQUEST_CHANGES` if findings meet or exceed the `request-changes-on` threshold, or `COMMENT` otherwise. GitHub outright rejects approvals submitted with `GITHUB_TOKEN`; when that happens the action automatically submits the review as `COMMENT` (with the LGTM body) and logs a warning. To submit real approvals, pass a PAT or GitHub App token via the `github-token` input. `REQUEST_CHANGES` works with `GITHUB_TOKEN` and blocks merges under required-review rules.
- **Thread reconciliation:** on every run, previous bot comment threads are reconciled - threads whose findings were no longer flagged in the latest review get an auto-reply and are resolved; threads whose findings persist are kept (no duplicate comments). Note: if fixed code shifts line numbers, the old thread is resolved and a new comment anchors to the updated line.
- **Diff truncation for large PRs:** For large changes exceeding ~70% of the model's context window, non-essential files are skipped first and remaining diffs are truncated. A clear truncation warning is included in the summary body so reviews remain transparent.
- **Empty-findings LGTM:** When no issues meet or exceed the severity threshold, the action submits a friendly "LGTM — no issues found" summary review without posting empty comments.
- **Unanchored findings:** If the LLM generates a finding for a line not modified in the pull request diff, the action safely downgrades it into the summary review table with a direct file and line reference, avoiding GitHub API validation errors.

---

## Reply Adjudication

When developers reply to an inline bot review comment, the action can automatically adjudicate whether the reply (and any code updates) resolves the finding. If resolved, the AI replies with its reasoning and resolves the review thread. If not, it explains what is still missing and leaves the thread open.

### Workflow Example

To enable reply adjudication, add the `pull_request_review_comment` event alongside your `pull_request` triggers:

```yaml
name: AI Code Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  pull_request_review_comment:
    types: [created]
permissions:
  contents: write
  pull-requests: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: yasserk41/github-ai-codereview-action@v1
        with:
          provider: openai
          adjudicate-replies: true
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

### Eligibility

Reply adjudication only runs when:
- The event is a reply to an existing comment (`in_reply_to_id` is present).
- The root comment was created by the AI review bot (contains the bot marker).
- The reply author is human (the bot ignores comments created by its own authenticated account, preventing self-trigger loops).
- The thread is not already resolved.

### Context Provided to AI

When adjudicating, the LLM receives comprehensive context:
- **Original finding:** The initial review comment verbatim.
- **Discussion:** All thread replies formatted as `- @author: body`.
- **Current file window:** The relevant source file centered around the finding line (`[line-60, line+60]`, up to 400 lines).
- **File PR diff:** The pull request patch for the file (up to 8,000 characters).

### Outcomes

The AI decides whether the reply justifies non-fix (e.g. intentional design decision, issue does not apply) or the latest diff/code shows the issue is fixed. It responds in 1–3 sentences of markdown directly addressing the developer:
- **`resolved`**: The AI posts its reasoning as a reply and resolves the review thread.
- **`unresolved`**: The AI posts what is still missing and leaves the thread open.
- **`skipped`**: Ineligible comments (self-reply, thread not found, already resolved, non-bot thread) are skipped without action.

The outcome is set in the `adjudication` action output (`resolved`, `unresolved`, or `skipped`).

### Disabling Adjudication

Reply adjudication is enabled by default. To turn it off, set the `adjudicate-replies` input to `'false'` in your workflow.

---

## Provider Examples

### z.ai

```yaml
name: AI Code Review (z.ai)
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: write
  pull-requests: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: yasserk41/github-ai-codereview-action@v1
        with:
          provider: zai
        env:
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
```

### Kimi (Moonshot AI)

```yaml
name: AI Code Review (Kimi)
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: write
  pull-requests: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: yasserk41/github-ai-codereview-action@v1
        with:
          provider: kimi
        env:
          KIMI_API_KEY: ${{ secrets.KIMI_API_KEY }}
```

### Custom OpenAI-Compatible Provider

You can point to self-hosted models or alternative inference providers (such as Groq, Ollama, Together AI, or vLLM):

```yaml
name: AI Code Review (Custom)
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: write
  pull-requests: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: yasserk41/github-ai-codereview-action@v1
        with:
          provider: custom
          model: llama-3.3-70b-versatile
          base-url: https://api.groq.com/openai/v1
          context-window: 131072
        env:
          CUSTOM_API_KEY: ${{ secrets.GROQ_API_KEY }}
```

---

## Development

Prerequisites: Node.js 20+ and npm.

### Installation

```bash
npm ci
```

### Running Tests

```bash
npm test
```

### Linting and Typechecking

```bash
npm run lint
npm run typecheck
```

### Building Distribution

```bash
npm run build
```

The action runs directly from the bundled entrypoint `dist/index.js` generated by `@vercel/ncc`. The `dist/` directory is committed to git so workflows do not need to install dependencies or compile at runtime. CI enforces distribution freshness using `git diff --exit-code dist/`.
