# AI Code Review Action Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a marketplace-ready GitHub Action that runs AI code review on PRs and posts inline comments plus a summary review, supporting OpenAI, Anthropic, z.ai, Kimi, and custom OpenAI-compatible endpoints.

**Architecture:** TypeScript node20 action bundled with `@vercel/ncc` into a committed `dist/index.js`. Pipeline: fetch PR diff → filter/truncate via token safety valve → build prompts → one LLM call through a provider adapter (structured JSON output) → filter findings → delete stale bot comments → post one PR review with inline comments + summary body.

**Tech Stack:** TypeScript (strict, CommonJS output), `@actions/core`, `@actions/github`, `openai`, `@anthropic-ai/sdk`, `zod`, `yaml`, `minimatch`, vitest, eslint (flat config), `@vercel/ncc`.

**Spec:** `docs/superpowers/specs/2026-09-04-ai-code-review-action-design.md`

## Global Constraints

- Runtime: `runs.using: node20`, entry `dist/index.js` **committed to git**; CI fails if `dist/` is stale.
- TypeScript `strict: true`, module `CommonJS` (ncc requirement). If `ncc build` fails on an ESM-only dependency, pin that dependency to its last dual-publish major.
- TDD: every task runs red → green before its commit. Tests: vitest, files in `__tests__/*.test.ts`.
- No comments in source code.
- Conventional commit messages (`feat:`, `test:`, `chore:`, `docs:`).
- API keys only via env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ZAI_API_KEY`, `KIMI_API_KEY`, `CUSTOM_API_KEY`); never log key values.
- Findings schema (exact): `{ file: string, line: integer ≥ 1, severity: 'critical' | 'warning' | 'suggestion', title: string, body: string }`, wrapped as `{ "findings": [...] }`.
- Comment marker string (exact, used to tag bot comments for cleanup): `<!-- ai-code-review-action -->`
- Default models: `gpt-4.1` (openai), `claude-sonnet-4-5` (anthropic), `glm-4.6` (zai), `kimi-k2` (kimi); `custom` requires `model` + `base-url` inputs.
- Default context windows: openai 1,000,000; anthropic 200,000; zai 200,000; kimi 131,072; custom input `context-window` default 128,000.
- Token safety valve: prompt budget = 70% of context window minus 2,000 overhead.
- Repo config file `.ai-review.yml`: keys `paths`, `paths-ignore`, `max-comments` (default 20), `review-style` (`high-signal` | `thorough`, default `high-signal`), `severity-threshold` (default `suggestion`), `custom-instructions`. Unknown keys are errors naming the key.

---

### Task 1: Project scaffold + CI

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `.gitignore`, `action.yml`, `.github/workflows/ci.yml`, `__tests__/toolchain.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: npm scripts `build` (ncc → `dist/index.js`), `test`, `lint`, `typecheck`; CI workflow that runs them; complete `action.yml` metadata (inputs/outputs consumed by Task 3's `readRawInputs`)

- [ ] **Step 1: Initialize package and install dependencies**

```bash
npm init -y
npm install @actions/core @actions/github openai @anthropic-ai/sdk zod yaml minimatch
npm install -D typescript vitest @vercel/ncc eslint typescript-eslint @types/node @octokit/core
```

Then set `package.json` fields (keep installed versions as-is):

```json
{
  "name": "ai-codereview-action",
  "description": "AI-powered code review with inline PR comments. Supports OpenAI, Anthropic, z.ai, Kimi, and OpenAI-compatible endpoints.",
  "private": true,
  "main": "dist/index.js",
  "scripts": {
    "build": "ncc build src/main.ts -o dist --license licenses.txt",
    "test": "vitest run",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Write configs**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["node"]
  },
  "include": ["src", "__tests__"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['__tests__/**/*.test.ts'] },
})
```

`eslint.config.js`:

```js
const tseslint = require('typescript-eslint')

module.exports = tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
)
```

`.gitignore`:

```
node_modules/
dist-tsc/
*.log
```

Note: `dist/` is NOT ignored — it ships in the repo.

`action.yml`:

```yaml
name: 'AI Code Review'
description: 'AI-powered code review with inline PR comments. Supports OpenAI, Anthropic, z.ai, Kimi, and OpenAI-compatible endpoints.'
author: 'yasserk41'
branding:
  icon: 'eye'
  color: 'purple'
inputs:
  provider:
    description: 'AI provider: openai | anthropic | zai | kimi | custom'
    required: false
    default: 'openai'
  model:
    description: 'Model name (defaults per provider: gpt-4.1, claude-sonnet-4-5, glm-4.6, kimi-k2)'
    required: false
    default: ''
  base-url:
    description: 'Required for provider "custom": OpenAI-compatible base URL'
    required: false
    default: ''
  context-window:
    description: 'Model context window in tokens (custom provider only; others use known values)'
    required: false
    default: '128000'
  github-token:
    description: 'Token used to read the PR and post the review'
    required: false
    default: '${{ github.token }}'
  config-path:
    description: 'Path to the .ai-review.yml config file in the reviewed repo'
    required: false
    default: '.ai-review.yml'
outputs:
  findings-count:
    description: 'Total findings reported'
  inline-comments:
    description: 'Number of inline comments posted'
runs:
  using: 'node20'
  main: 'dist/index.js'
```

`.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
  pull_request:
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - run: git diff --exit-code dist/
```

- [ ] **Step 3: Write the toolchain smoke test**

`__tests__/toolchain.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

describe('toolchain', () => {
  it('compiles TypeScript strict mode and runs vitest', () => {
    const x: number = 41 + 1
    expect(x).toBe(42)
  })
})
```

- [ ] **Step 4: Run all checks**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all PASS (0 test files failed, 1 passed).

Note: `npm run build` will fail until `src/main.ts` exists (Task 11) — that is expected; the CI dist-check step stays red only until Task 11 adds `dist/`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold TypeScript action project with CI"
```

---

### Task 2: Finding schema and provider types

**Files:**
- Create: `src/providers/types.ts`
- Test: `__tests__/types.test.ts`

**Interfaces:**
- Consumes: `zod`
- Produces: `Severity`, `SEVERITIES`, `SEVERITY_RANK`, `Finding`, `FindingSchema`, `FileDiff`, `DiffContext`, `ReviewConfig`, `ReviewProvider` (interface: `complete(system: string, user: string): Promise<Finding[]>`), `ProviderError`, `ConfigError` (re-exported home), `parseFindings(raw: string): Finding[]`, `FINDINGS_JSON_SCHEMA` (plain JSON Schema object), `REPAIR_INSTRUCTION` (string constant), `COMMENT_MARKER` (string constant)

- [ ] **Step 1: Write the failing tests**

`__tests__/types.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseFindings, ProviderError, SEVERITY_RANK } from '../src/providers/types'

const finding = {
  file: 'src/app.ts',
  line: 3,
  severity: 'critical',
  title: 'Remote code execution',
  body: 'eval() on user input allows arbitrary code execution.',
}

describe('parseFindings', () => {
  it('parses a plain JSON object', () => {
    expect(parseFindings(JSON.stringify({ findings: [finding] }))).toEqual([finding])
  })

  it('strips markdown code fences', () => {
    const raw = '```json\n' + JSON.stringify({ findings: [finding] }) + '\n```'
    expect(parseFindings(raw)).toEqual([finding])
  })

  it('accepts a bare findings array', () => {
    expect(parseFindings(JSON.stringify([finding]))).toEqual([finding])
  })

  it('returns empty array for empty findings', () => {
    expect(parseFindings('{"findings":[]}')).toEqual([])
  })

  it('throws ProviderError on invalid JSON', () => {
    expect(() => parseFindings('not json at all')).toThrow(ProviderError)
  })

  it('throws ProviderError naming the offending key', () => {
    const bad = JSON.stringify({ findings: [{ ...finding, severity: 'fatal' }] })
    expect(() => parseFindings(bad)).toThrow(/severity/)
  })
})

describe('SEVERITY_RANK', () => {
  it('orders critical > warning > suggestion', () => {
    expect(SEVERITY_RANK.critical).toBeGreaterThan(SEVERITY_RANK.warning)
    expect(SEVERITY_RANK.warning).toBeGreaterThan(SEVERITY_RANK.suggestion)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- types.test`
Expected: FAIL — cannot resolve `../src/providers/types`.

- [ ] **Step 3: Write the implementation**

`src/providers/types.ts`:

```ts
import { z } from 'zod'

export const SEVERITIES = ['critical', 'warning', 'suggestion'] as const
export type Severity = (typeof SEVERITIES)[number]

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 3,
  warning: 2,
  suggestion: 1,
}

export const FindingSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  severity: z.enum(SEVERITIES),
  title: z.string().min(1),
  body: z.string().min(1),
})

export type Finding = z.infer<typeof FindingSchema>

export const FindingsPayloadSchema = z.object({
  findings: z.array(FindingSchema),
})

export class ProviderError extends Error {
  constructor(message: string, readonly raw?: string) {
    super(message)
    this.name = 'ProviderError'
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export function parseFindings(raw: string): Finding[] {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  let json: unknown
  try {
    json = JSON.parse(stripped)
  } catch {
    throw new ProviderError('LLM response was not valid JSON', raw)
  }
  if (Array.isArray(json)) json = { findings: json }
  const parsed = FindingsPayloadSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new ProviderError(
      `LLM JSON did not match findings schema at "${issue.path.join('.')}": ${issue.message}`,
      raw,
    )
  }
  return parsed.data.findings
}

export const FINDINGS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['critical', 'warning', 'suggestion'] },
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['file', 'line', 'severity', 'title', 'body'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
} as const

export const REPAIR_INSTRUCTION =
  '\n\nIMPORTANT: Your previous response was not valid JSON matching the required schema. Respond again with ONLY the JSON object {"findings":[...]}. No prose, no markdown fences.'

export const COMMENT_MARKER = '<!-- ai-code-review-action -->'

export interface FileDiff {
  path: string
  patch: string
  commentableLines: number[]
}

export interface DiffContext {
  files: FileDiff[]
  truncated: boolean
  skipped: string[]
  estimatedTokens: number
}

export interface ReviewConfig {
  provider: string
  model: string
  contextWindowTokens: number
  maxComments: number
  reviewStyle: 'high-signal' | 'thorough'
  severityThreshold: Severity
  customInstructions?: string
}

export interface ReviewProvider {
  complete(system: string, user: string): Promise<Finding[]>
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- types.test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/types.ts __tests__/types.test.ts
git commit -m "feat: finding schema, provider types, LLM response parsing"
```

---

### Task 3: Configuration (action inputs + .ai-review.yml)

**Files:**
- Create: `src/config.ts`
- Test: `__tests__/config.test.ts`

**Interfaces:**
- Consumes: `ConfigError`, `Severity` (Task 2)
- Produces: `RepoConfig` (`{ paths: string[]; pathsIgnore: string[]; maxComments: number; reviewStyle: 'high-signal'|'thorough'; severityThreshold: Severity; customInstructions?: string }`), `RawInputs` (`{ provider: string; model: string; baseUrl: string; contextWindow: string; githubToken: string; configPath: string }`), `loadRepoConfig(path: string): Promise<RepoConfig>`, `readRawInputs(getInput?: (name: string) => string): RawInputs`, `resolveConfig(raw: RawInputs, repo: RepoConfig, preset: { defaultModel: string; contextWindowTokens: number }): ReviewConfig`

- [ ] **Step 1: Write the failing tests**

`__tests__/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRepoConfig, readRawInputs, resolveConfig, ConfigError } from '../src/config'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ai-review-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('loadRepoConfig', () => {
  it('returns defaults when the file is missing', async () => {
    const config = await loadRepoConfig(join(dir, '.ai-review.yml'))
    expect(config).toEqual({
      paths: ['**/*'],
      pathsIgnore: [],
      maxComments: 20,
      reviewStyle: 'high-signal',
      severityThreshold: 'suggestion',
    })
  })

  it('parses a full config file', async () => {
    const path = join(dir, '.ai-review.yml')
    await writeFile(
      path,
      [
        'paths: ["src/**"]',
        'paths-ignore: ["**/*.test.ts"]',
        'max-comments: 5',
        'review-style: thorough',
        'severity-threshold: warning',
        'custom-instructions: |',
        '  We use Vitest, not Jest.',
      ].join('\n'),
    )
    const config = await loadRepoConfig(path)
    expect(config.paths).toEqual(['src/**'])
    expect(config.pathsIgnore).toEqual(['**/*.test.ts'])
    expect(config.maxComments).toBe(5)
    expect(config.reviewStyle).toBe('thorough')
    expect(config.severityThreshold).toBe('warning')
    expect(config.customInstructions).toBe('We use Vitest, not Jest.\n')
  })

  it('fails naming the offending key on unknown keys', async () => {
    const path = join(dir, '.ai-review.yml')
    await writeFile(path, 'mx-comments: 5')
    await expect(loadRepoConfig(path)).rejects.toThrow(/mx-comments/)
  })

  it('fails on invalid values', async () => {
    const path = join(dir, '.ai-review.yml')
    await writeFile(path, 'max-comments: -3')
    await expect(loadRepoConfig(path)).rejects.toThrow(ConfigError)
  })

  it('fails with a parse error on malformed YAML', async () => {
    const path = join(dir, '.ai-review.yml')
    await writeFile(path, 'paths: ["unterminated')
    await expect(loadRepoConfig(path)).rejects.toThrow(/parse/i)
  })
})

describe('readRawInputs', () => {
  it('applies fallback defaults when inputs are empty', () => {
    const raw = readRawInputs(() => '')
    expect(raw.provider).toBe('openai')
    expect(raw.configPath).toBe('.ai-review.yml')
    expect(raw.contextWindow).toBe('128000')
    expect(raw.githubToken).toBe('')
  })

  it('reads provided inputs', () => {
    const raw = readRawInputs(
      (name) =>
        ({ provider: 'kimi', model: 'kimi-k2', 'github-token': 't' } as Record<string, string>)[
          name
        ] ?? '',
    )
    expect(raw.provider).toBe('kimi')
    expect(raw.model).toBe('kimi-k2')
    expect(raw.githubToken).toBe('t')
  })
})

describe('resolveConfig', () => {
  const raw = readRawInputs(() => '')
  const repo = { paths: ['**/*'], pathsIgnore: [], maxComments: 20, reviewStyle: 'high-signal', severityThreshold: 'suggestion' } as const

  it('uses preset defaults when inputs are empty', () => {
    const config = resolveConfig(raw, repo, { defaultModel: 'glm-4.6', contextWindowTokens: 200000 })
    expect(config.model).toBe('glm-4.6')
    expect(config.contextWindowTokens).toBe(200000)
  })

  it('input model overrides preset default', () => {
    const config = resolveConfig(
      { ...raw, model: 'gpt-4o' },
      repo,
      { defaultModel: 'gpt-4.1', contextWindowTokens: 1000000 },
    )
    expect(config.model).toBe('gpt-4o')
  })

  it('input context-window overrides preset default', () => {
    const config = resolveConfig(
      { ...raw, contextWindow: '64000' },
      repo,
      { defaultModel: 'm', contextWindowTokens: 200000 },
    )
    expect(config.contextWindowTokens).toBe(64000)
  })

  it('propagates repo config', () => {
    const config = resolveConfig(raw, { ...repo, maxComments: 3 }, { defaultModel: 'm', contextWindowTokens: 1000 })
    expect(config.maxComments).toBe(3)
    expect(config.provider).toBe('openai')
  })
})
```

Add to the top of the file (vitest globals are not enabled, so import them):

```ts
import { beforeEach, afterEach } from 'vitest'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- config.test`
Expected: FAIL — cannot resolve `../src/config`.

- [ ] **Step 3: Write the implementation**

`src/config.ts`:

```ts
import * as core from '@actions/core'
import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { ConfigError, type ReviewConfig, type Severity } from './providers/types'

const RepoConfigSchema = z
  .object({
    paths: z.array(z.string()).default(['**/*']),
    'paths-ignore': z.array(z.string()).default([]),
    'max-comments': z.number().int().min(0).default(20),
    'review-style': z.enum(['high-signal', 'thorough']).default('high-signal'),
    'severity-threshold': z.enum(['critical', 'warning', 'suggestion']).default('suggestion'),
    'custom-instructions': z.string().optional(),
  })
  .strict()

export interface RepoConfig {
  paths: string[]
  pathsIgnore: string[]
  maxComments: number
  reviewStyle: 'high-signal' | 'thorough'
  severityThreshold: Severity
  customInstructions?: string
}

export interface RawInputs {
  provider: string
  model: string
  baseUrl: string
  contextWindow: string
  githubToken: string
  configPath: string
}

export async function loadRepoConfig(path: string): Promise<RepoConfig> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return RepoConfigSchema.parse({})
    }
    throw new ConfigError(`Could not read ${path}: ${String(err)}`)
  }
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (err) {
    throw new ConfigError(`Could not parse ${path} as YAML: ${String(err)}`)
  }
  const parsed = RepoConfigSchema.safeParse(raw ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const key = issue.path.join('.') || 'document'
    throw new ConfigError(`Invalid ${path}: "${key}" ${issue.message}`)
  }
  const c = parsed.data
  return {
    paths: c.paths,
    pathsIgnore: c['paths-ignore'],
    maxComments: c['max-comments'],
    reviewStyle: c['review-style'],
    severityThreshold: c['severity-threshold'],
    customInstructions: c['custom-instructions'],
  }
}

export function readRawInputs(
  getInput: (name: string) => string = core.getInput,
): RawInputs {
  return {
    provider: getInput('provider') || 'openai',
    model: getInput('model') || '',
    baseUrl: getInput('base-url') || '',
    contextWindow: getInput('context-window') || '128000',
    githubToken: getInput('github-token'),
    configPath: getInput('config-path') || '.ai-review.yml',
  }
}

export function resolveConfig(
  raw: RawInputs,
  repo: RepoConfig,
  preset: { defaultModel: string; contextWindowTokens: number },
): ReviewConfig {
  return {
    provider: raw.provider,
    model: raw.model || preset.defaultModel,
    contextWindowTokens: raw.contextWindow
      ? Number(raw.contextWindow)
      : preset.contextWindowTokens,
    maxComments: repo.maxComments,
    reviewStyle: repo.reviewStyle,
    severityThreshold: repo.severityThreshold,
    customInstructions: repo.customInstructions,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- config.test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts __tests__/config.test.ts
git commit -m "feat: action inputs, .ai-review.yml loading, config resolution"
```

---

### Task 4: Diff fetching, filtering, and token safety valve

**Files:**
- Create: `src/diff.ts`
- Test: `__tests__/diff.test.ts`

**Interfaces:**
- Consumes: `FileDiff`, `DiffContext` (Task 2), `RepoConfig` (Task 3), `Octokit` from `@octokit/core`
- Produces: `RawFile` (`{ filename: string; patch?: string; additions: number; deletions: number }`), `fetchPrFiles(octokit: Octokit, repo: { owner: string; repo: string }, prNumber: number): Promise<RawFile[]>`, `parseCommentableLines(patch: string): number[]`, `estimateTokens(text: string): number`, `buildDiffContext(files: RawFile[], config: Pick<RepoConfig, 'paths' | 'pathsIgnore'>, contextWindowTokens: number): DiffContext`

The shared patch fixture used by later tests (put it inline in this test file, and reuse the string in Tasks 9/10 by copying it):

```ts
const SAMPLE_PATCH = '@@ -1,4 +1,6 @@\n const a = 1\n-const b = 2\n+const b = 3\n+const c = eval("userInput")\n // done'
```

Its commentable right-side lines are `[1, 2, 3, 4]`.

- [ ] **Step 1: Write the failing tests**

`__tests__/diff.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import type { Octokit } from '@octokit/core'
import {
  buildDiffContext,
  estimateTokens,
  fetchPrFiles,
  parseCommentableLines,
} from '../src/diff'

const SAMPLE_PATCH =
  '@@ -1,4 +1,6 @@\n const a = 1\n-const b = 2\n+const b = 3\n+const c = eval("userInput")\n // done'

const NO_FILTER = { paths: ['**/*'], pathsIgnore: [] }

describe('parseCommentableLines', () => {
  it('returns right-side line numbers for added and context lines', () => {
    expect(parseCommentableLines(SAMPLE_PATCH)).toEqual([1, 2, 3, 4])
  })

  it('handles multiple hunks', () => {
    const patch = '@@ -10,2 +10,2 @@\n context\n+added\n@@ -50,2 +52,2 @@\n context\n+other'
    expect(parseCommentableLines(patch)).toEqual([10, 11, 52, 53])
  })

  it('skips "no newline" markers', () => {
    const patch = '@@ -1,1 +1,2 @@\n+first\n\\ No newline at end of file'
    expect(parseCommentableLines(patch)).toEqual([1])
  })
})

describe('estimateTokens', () => {
  it('estimates 4 characters per token, rounded up', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abc')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })
})

describe('buildDiffContext', () => {
  it('keeps matching files with patches', () => {
    const files = [
      { filename: 'src/app.ts', patch: SAMPLE_PATCH, additions: 2, deletions: 1 },
      { filename: 'logo.png', additions: 1, deletions: 0 },
    ]
    const diff = buildDiffContext(files, NO_FILTER, 128000)
    expect(diff.files.map((f) => f.path)).toEqual(['src/app.ts'])
    expect(diff.files[0].commentableLines).toEqual([1, 2, 3, 4])
    expect(diff.truncated).toBe(false)
    expect(diff.skipped).toEqual(['logo.png'])
  })

  it('applies paths filters', () => {
    const files = [
      { filename: 'src/app.ts', patch: SAMPLE_PATCH, additions: 2, deletions: 1 },
      { filename: 'docs/readme.md', patch: SAMPLE_PATCH, additions: 2, deletions: 1 },
    ]
    const diff = buildDiffContext(files, { paths: ['src/**'], pathsIgnore: [] }, 128000)
    expect(diff.files.map((f) => f.path)).toEqual(['src/app.ts'])
  })

  it('drops lock and vendored files first when over budget', () => {
    const files = [
      { filename: 'src/app.ts', patch: SAMPLE_PATCH, additions: 2, deletions: 1 },
      { filename: 'package-lock.json', patch: '+'.repeat(4000), additions: 4000, deletions: 0 },
    ]
    const diff = buildDiffContext(files, NO_FILTER, 1000)
    expect(diff.files.map((f) => f.path)).toEqual(['src/app.ts'])
    expect(diff.skipped).toContain('package-lock.json')
    expect(diff.truncated).toBe(true)
  })

  it('drops largest remaining files when still over budget', () => {
    const files = [
      { filename: 'small.ts', patch: '+small', additions: 1, deletions: 0 },
      { filename: 'large.ts', patch: '+' + 'x'.repeat(4000), additions: 4000, deletions: 0 },
    ]
    const diff = buildDiffContext(files, NO_FILTER, 1000)
    expect(diff.files.map((f) => f.path)).toEqual(['small.ts'])
    expect(diff.skipped).toContain('large.ts')
    expect(diff.truncated).toBe(true)
  })

  it('truncates a single oversized file patch', () => {
    const files = [
      { filename: 'huge.ts', patch: '+' + 'x'.repeat(8000), additions: 8000, deletions: 0 },
    ]
    const diff = buildDiffContext(files, NO_FILTER, 1000)
    expect(diff.files).toHaveLength(1)
    expect(diff.files[0].patch.length).toBeLessThan(4000)
    expect(diff.files[0].patch).toContain('[patch truncated]')
    expect(diff.truncated).toBe(true)
  })
})

describe('fetchPrFiles', () => {
  it('paginates pulls.listFiles and returns file payloads', async () => {
    const files = [{ filename: 'a.ts', patch: SAMPLE_PATCH, additions: 1, deletions: 0 }]
    const paginate = vi.fn().mockResolvedValue(files)
    const octokit = { paginate } as unknown as Octokit
    const result = await fetchPrFiles(octokit, { owner: 'o', repo: 'r' }, 7)
    expect(result).toEqual(files)
    expect(paginate).toHaveBeenCalledWith(expect.anything(), {
      owner: 'o',
      repo: 'r',
      pull_number: 7,
      per_page: 100,
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- diff.test`
Expected: FAIL — cannot resolve `../src/diff`.

- [ ] **Step 3: Write the implementation**

`src/diff.ts`:

```ts
import { minimatch } from 'minimatch'
import type { Octokit } from '@octokit/core'
import type { DiffContext, FileDiff } from './providers/types'

export interface RawFile {
  filename: string
  patch?: string
  additions: number
  deletions: number
}

export async function fetchPrFiles(
  octokit: Octokit,
  repo: { owner: string; repo: string },
  prNumber: number,
): Promise<RawFile[]> {
  return octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: repo.owner,
    repo: repo.repo,
    pull_number: prNumber,
    per_page: 100,
  })
}

export function parseCommentableLines(patch: string): number[] {
  const lines: number[] = []
  let current: number | null = null
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      current = Number(hunk[1])
      continue
    }
    if (current === null) continue
    if (line.startsWith('\\')) continue
    if (line.startsWith('-')) continue
    lines.push(current)
    current++
  }
  return lines
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

const VALVE_IGNORED = [
  '**/*.lock',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/go.sum',
  '**/*.min.js',
  '**/*.map',
  'vendor/**',
  'third_party/**',
  'dist/**',
]

const PROMPT_OVERHEAD_TOKENS = 2000

export function buildDiffContext(
  files: RawFile[],
  config: { paths: string[]; pathsIgnore: string[] },
  contextWindowTokens: number,
): DiffContext {
  const skipped: string[] = []
  const matched: FileDiff[] = []
  for (const file of files) {
    if (typeof file.patch !== 'string') {
      skipped.push(file.filename)
      continue
    }
    const included =
      config.paths.some((p) => minimatch(file.filename, p)) &&
      !config.pathsIgnore.some((p) => minimatch(file.filename, p))
    if (included) {
      matched.push({
        path: file.filename,
        patch: file.patch,
        commentableLines: parseCommentableLines(file.patch),
      })
    }
  }

  const budget = Math.floor(contextWindowTokens * 0.7) - PROMPT_OVERHEAD_TOKENS
  let truncated = false
  let working = [...matched]

  if (working.length > 0 && estimateTokens(JSON.stringify(working.map((f) => f.patch))) > budget) {
    const valveSafe = working.filter(
      (f) => !VALVE_IGNORED.some((p) => minimatch(f.path, p)),
    )
    const dropped = working.filter((f) => !valveSafe.includes(f))
    skipped.push(...dropped.map((f) => f.path))
    truncated = truncated || dropped.length > 0
    working = valveSafe
  }

  if (working.length > 1) {
    const total = () => working.reduce((sum, f) => sum + estimateTokens(f.patch), 0)
    while (total() > budget && working.length > 1) {
      working.sort((a, b) => estimateTokens(b.patch) - estimateTokens(a.patch))
      const removed = working.shift()
      if (removed) skipped.push(removed.path)
      truncated = true
    }
  }

  if (working.length === 1) {
    const sole = working[0]
    const charBudget = budget * 4
    if (sole.patch.length > charBudget) {
      sole.patch = sole.patch.slice(0, Math.max(0, charBudget - 20)) + '\n[patch truncated]'
      sole.commentableLines = parseCommentableLines(sole.patch)
      truncated = true
    }
  }

  return {
    files: working,
    truncated,
    skipped,
    estimatedTokens: working.reduce((sum, f) => sum + estimateTokens(f.patch), 0),
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- diff.test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/diff.ts __tests__/diff.test.ts
git commit -m "feat: PR diff fetching, glob filters, token safety valve"
```

---

### Task 5: Prompt builder

**Files:**
- Create: `src/prompt.ts`
- Test: `__tests__/prompt.test.ts`

**Interfaces:**
- Consumes: `DiffContext`, `ReviewConfig` (Task 2)
- Produces: `buildSystemPrompt(config: ReviewConfig): string`, `buildUserPrompt(diff: DiffContext, pr: { title: string; body: string }): string`

- [ ] **Step 1: Write the failing tests**

`__tests__/prompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildSystemPrompt, buildUserPrompt } from '../src/prompt'
import type { DiffContext, ReviewConfig } from '../src/providers/types'

const baseConfig: ReviewConfig = {
  provider: 'openai',
  model: 'gpt-4.1',
  contextWindowTokens: 1000000,
  maxComments: 20,
  reviewStyle: 'high-signal',
  severityThreshold: 'suggestion',
}

const sampleDiff: DiffContext = {
  files: [
    { path: 'src/app.ts', patch: '@@ -1,1 +1,2 @@\n+const b = 3', commentableLines: [1, 2] },
  ],
  truncated: false,
  skipped: [],
  estimatedTokens: 10,
}

describe('buildSystemPrompt', () => {
  it('high-signal style forbids style nits', () => {
    const prompt = buildSystemPrompt(baseConfig)
    expect(prompt).toContain('bugs, security vulnerabilities, logic errors, and performance problems')
    expect(prompt).not.toContain('naming')
  })

  it('thorough style includes naming and documentation', () => {
    const prompt = buildSystemPrompt({ ...baseConfig, reviewStyle: 'thorough' })
    expect(prompt).toContain('naming')
    expect(prompt).toContain('documentation')
  })

  it('appends custom instructions verbatim', () => {
    const prompt = buildSystemPrompt({ ...baseConfig, customInstructions: 'We use Vitest.' })
    expect(prompt).toContain('We use Vitest.')
  })

  it('states the JSON contract and severity levels', () => {
    const prompt = buildSystemPrompt(baseConfig)
    expect(prompt).toContain('"findings"')
    expect(prompt).toContain('critical')
    expect(prompt).toContain('suggestion')
    expect(prompt).toContain('empty findings array')
  })
})

describe('buildUserPrompt', () => {
  it('includes PR title, body, file paths, and patches', () => {
    const prompt = buildUserPrompt(sampleDiff, { title: 'Fix bug', body: 'Fixes #1' })
    expect(prompt).toContain('Fix bug')
    expect(prompt).toContain('Fixes #1')
    expect(prompt).toContain('src/app.ts')
    expect(prompt).toContain('const b = 3')
  })

  it('handles a missing PR body', () => {
    const prompt = buildUserPrompt(sampleDiff, { title: 'T', body: '' })
    expect(prompt).toContain('T')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- prompt.test`
Expected: FAIL — cannot resolve `../src/prompt`.

- [ ] **Step 3: Write the implementation**

`src/prompt.ts`:

```ts
import type { DiffContext, ReviewConfig } from './providers/types'

export function buildSystemPrompt(config: ReviewConfig): string {
  const focus =
    config.reviewStyle === 'thorough'
      ? 'You review code thoroughly: correctness, security, performance, style, naming, and documentation.'
      : 'You review code for high-signal issues only: bugs, security vulnerabilities, logic errors, and performance problems. Do not comment on style, formatting, naming, or documentation unless it causes a real problem.'
  return [
    'You are an expert code reviewer embedded in a CI pipeline.',
    focus,
    '',
    'Severity levels:',
    '- critical: bugs that break functionality, security vulnerabilities, data loss',
    '- warning: likely bugs, risky patterns, performance issues',
    '- suggestion: meaningful improvements worth considering',
    '',
    'Rules:',
    '- Only report findings anchored to a specific line of the provided diff (use right-side line numbers).',
    '- Only report issues in lines the diff touches or lines directly adjacent to them.',
    '- If the code is fine, return an empty findings array.',
    '- Respond ONLY with JSON of the form {"findings":[{"file":string,"line":integer,"severity":"critical"|"warning"|"suggestion","title":string,"body":string}]}.',
    config.customInstructions
      ? `\nProject-specific instructions from the maintainers (follow closely):\n${config.customInstructions}`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export function buildUserPrompt(
  diff: DiffContext,
  pr: { title: string; body: string },
): string {
  const sections = diff.files
    .map((f) => `### ${f.path}\n\`\`\`diff\n${f.patch}\n\`\`\``)
    .join('\n\n')
  const header = `Pull request: ${pr.title}\n\n${pr.body || '(no description)'}`
  return `${header}\n\nDiff to review (right-side line numbers are inside the @@ hunk headers):\n\n${sections}`
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- prompt.test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prompt.ts __tests__/prompt.test.ts
git commit -m "feat: system and user prompt builders"
```

---

### Task 6: OpenAI adapter

**Files:**
- Create: `src/providers/openai.ts`
- Test: `__tests__/providers/openai.test.ts`

**Interfaces:**
- Consumes: `ReviewProvider`, `parseFindings`, `FINDINGS_JSON_SCHEMA`, `REPAIR_INSTRUCTION`, `ProviderError` (Task 2)
- Produces: `OpenAIProvider` — `constructor(model: string, apiKey: string, baseUrl?: string, client?: OpenAI)`, implements `complete`. Subclass hook for Task 8: instance fields `client: OpenAI` (protected) and `responseFormat(model): openai response_format object | undefined` (protected, overridable).

- [ ] **Step 1: Write the failing tests**

`__tests__/providers/openai.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import type OpenAI from 'openai'
import { OpenAIProvider } from '../../src/providers/openai'
import type { Finding } from '../../src/providers/types'

const finding: Finding = {
  file: 'src/app.ts',
  line: 3,
  severity: 'critical',
  title: 'Remote code execution',
  body: 'eval() on user input.',
}

function fakeClient(contents: string[]) {
  const create = vi.fn()
  for (const content of contents) {
    create.mockResolvedValueOnce({ choices: [{ message: { content } }] })
  }
  return {
    create,
    calls: () => create.mock.calls as unknown as [Record<string, unknown>][],
  }
}

function providerWith(contents: string[]): { provider: OpenAIProvider; create: ReturnType<typeof fakeClient>['create']; calls: () => unknown[] } {
  const client = fakeClient(contents)
  return {
    provider: new OpenAIProvider('gpt-4.1', 'key', undefined, client as unknown as OpenAI),
    create: client.create,
    calls: client.calls,
  }
}

describe('OpenAIProvider.complete', () => {
  it('returns parsed findings and requests json_schema output', async () => {
    const { provider, calls } = providerWith([JSON.stringify({ findings: [finding] })])
    const result = await provider.complete('system', 'user')
    expect(result).toEqual([finding])
    const body = calls()[0][0] as Record<string, unknown>
    expect(body['model']).toBe('gpt-4.1')
    expect(body['response_format']).toEqual({
      type: 'json_schema',
      json_schema: { name: 'findings', strict: true, schema: expect.any(Object) },
    })
  })

  it('retries once with the repair instruction on invalid JSON', async () => {
    const { provider, calls } = providerWith(['nope', JSON.stringify({ findings: [] })])
    const result = await provider.complete('system', 'user')
    expect(result).toEqual([])
    expect(calls()).toHaveLength(2)
    const retryBody = calls()[1][0] as { messages: { content: string }[] }
    expect(retryBody.messages[1].content).toContain('IMPORTANT')
  })

  it('throws ProviderError when the retry also fails', async () => {
    const { provider } = providerWith(['nope', 'still nope'])
    await expect(provider.complete('system', 'user')).rejects.toThrow(/not valid JSON/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- providers/openai.test`
Expected: FAIL — cannot resolve `../../src/providers/openai`.

- [ ] **Step 3: Write the implementation**

`src/providers/openai.ts`:

```ts
import OpenAI from 'openai'
import {
  FINDINGS_JSON_SCHEMA,
  parseFindings,
  REPAIR_INSTRUCTION,
  type Finding,
  type ReviewProvider,
} from './types'

export class OpenAIProvider implements ReviewProvider {
  protected client: OpenAI

  constructor(
    protected model: string,
    apiKey: string,
    baseUrl?: string,
    client?: OpenAI,
  ) {
    this.client =
      client ?? new OpenAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) })
  }

  protected responseFormat(): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming['response_format'] {
    return {
      type: 'json_schema',
      json_schema: { name: 'findings', strict: true, schema: FINDINGS_JSON_SCHEMA },
    }
  }

  async complete(system: string, user: string): Promise<Finding[]> {
    const ask = async (u: string): Promise<string> => {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0.1,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: u },
        ],
        ...(this.responseFormat() ? { response_format: this.responseFormat() } : {}),
      })
      return response.choices[0]?.message?.content ?? ''
    }
    try {
      return parseFindings(await ask(user))
    } catch {
      return parseFindings(await ask(user + REPAIR_INSTRUCTION))
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- providers/openai.test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/openai.ts __tests__/providers/openai.test.ts
git commit -m "feat: OpenAI adapter with structured output and repair retry"
```

---

### Task 7: Anthropic adapter

**Files:**
- Create: `src/providers/anthropic.ts`
- Test: `__tests__/providers/anthropic.test.ts`

**Interfaces:**
- Consumes: `ReviewProvider`, `parseFindings`, `FINDINGS_JSON_SCHEMA`, `REPAIR_INSTRUCTION` (Task 2), `@anthropic-ai/sdk`
- Produces: `AnthropicProvider` — `constructor(model: string, apiKey: string, client?: Anthropic)`, implements `complete`

- [ ] **Step 1: Write the failing tests**

`__tests__/providers/anthropic.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { AnthropicProvider } from '../../src/providers/anthropic'
import type { Finding } from '../../src/providers/types'

const finding: Finding = {
  file: 'src/app.ts',
  line: 3,
  severity: 'warning',
  title: 'Unhandled promise',
  body: 'Floating promise may swallow errors.',
}

function toolResponse(input: unknown) {
  return { content: [{ type: 'tool_use', id: 't1', name: 'submit_findings', input }] }
}

describe('AnthropicProvider.complete', () => {
  it('forces the submit_findings tool and parses its input', async () => {
    const create = vi.fn().mockResolvedValue(toolResponse({ findings: [finding] }))
    const provider = new AnthropicProvider(
      'claude-sonnet-4-5',
      'key',
      { messages: { create } } as unknown as Anthropic,
    )
    const result = await provider.complete('system', 'user')
    expect(result).toEqual([finding])
    const body = create.mock.calls[0][0] as Record<string, unknown>
    expect(body['model']).toBe('claude-sonnet-4-5')
    expect(body['tool_choice']).toEqual({ type: 'tool', name: 'submit_findings' })
    expect((body['tools'] as { name: string }[])[0].name).toBe('submit_findings')
  })

  it('retries once when the tool input does not validate', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(toolResponse({ findings: [{ ...finding, line: 0 }] }))
      .mockResolvedValueOnce(toolResponse({ findings: [] }))
    const provider = new AnthropicProvider(
      'claude-sonnet-4-5',
      'key',
      { messages: { create } } as unknown as Anthropic,
    )
    const result = await provider.complete('system', 'user')
    expect(result).toEqual([])
    expect(create).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- providers/anthropic.test`
Expected: FAIL — cannot resolve `../../src/providers/anthropic`.

- [ ] **Step 3: Write the implementation**

`src/providers/anthropic.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk'
import {
  FINDINGS_JSON_SCHEMA,
  parseFindings,
  REPAIR_INSTRUCTION,
  type Finding,
  type ReviewProvider,
} from './types'

export class AnthropicProvider implements ReviewProvider {
  private client: Anthropic

  constructor(
    private model: string,
    apiKey: string,
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic({ apiKey })
  }

  async complete(system: string, user: string): Promise<Finding[]> {
    const ask = async (u: string): Promise<string> => {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 8192,
        temperature: 0.1,
        system,
        messages: [{ role: 'user', content: u }],
        tools: [
          {
            name: 'submit_findings',
            description: 'Submit your code review findings',
            input_schema: FINDINGS_JSON_SCHEMA,
          },
        ],
        tool_choice: { type: 'tool', name: 'submit_findings' },
      })
      const block = response.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      )
      return block ? JSON.stringify(block.input) : ''
    }
    try {
      return parseFindings(await ask(user))
    } catch {
      return parseFindings(await ask(user + REPAIR_INSTRUCTION))
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- providers/anthropic.test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/anthropic.ts __tests__/providers/anthropic.test.ts
git commit -m "feat: Anthropic adapter with forced tool-use output"
```

---

### Task 8: OpenAI-compatible adapter + provider registry

**Files:**
- Create: `src/providers/openai-compatible.ts`, `src/providers/registry.ts`
- Test: `__tests__/providers/registry.test.ts`

**Interfaces:**
- Consumes: `OpenAIProvider` (Task 6), `AnthropicProvider` (Task 7), `RawInputs` (Task 3), Task 2 types
- Produces: `OpenAICompatibleProvider` (`constructor(model: string, apiKey: string, baseUrl: string, client?: OpenAI)` — overrides `responseFormat()` to `{ type: 'json_object' }`); `ProviderPreset` (`{ adapter: 'openai' | 'anthropic' | 'openai-compatible'; defaultModel: string; baseUrl?: string; apiKeyEnv: string; contextWindowTokens: number }`); `PRESETS: Record<string, ProviderPreset>` (keys `openai`, `anthropic`, `zai`, `kimi`, `custom`); `getPreset(provider: string): ProviderPreset`; `createProvider(raw: RawInputs): ReviewProvider`; `ProviderConfigError`

- [ ] **Step 1: Write the failing tests**

`__tests__/providers/registry.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import type OpenAI from 'openai'
import {
  PRESETS,
  createProvider,
  getPreset,
  ProviderConfigError,
} from '../../src/providers/registry'
import { OpenAICompatibleProvider } from '../../src/providers/openai-compatible'
import { AnthropicProvider } from '../../src/providers/anthropic'
import type { RawInputs } from '../../src/config'

function raw(overrides: Partial<RawInputs> = {}): RawInputs {
  return {
    provider: 'openai',
    model: '',
    baseUrl: '',
    contextWindow: '128000',
    githubToken: 't',
    configPath: '.ai-review.yml',
    ...overrides,
  }
}

describe('PRESETS', () => {
  it('has the five supported providers with defaults', () => {
    expect(Object.keys(PRESETS).sort()).toEqual(['anthropic', 'custom', 'kimi', 'openai', 'zai'])
    expect(PRESETS['zai'].baseUrl).toBe('https://api.z.ai/api/paas/v4')
    expect(PRESETS['kimi'].baseUrl).toBe('https://api.moonshot.ai/v1')
    expect(PRESETS['openai'].defaultModel).toBe('gpt-4.1')
    expect(PRESETS['anthropic'].defaultModel).toBe('claude-sonnet-4-5')
    expect(PRESETS['zai'].apiKeyEnv).toBe('ZAI_API_KEY')
    expect(PRESETS['kimi'].apiKeyEnv).toBe('KIMI_API_KEY')
  })
})

describe('getPreset', () => {
  it('throws listing supported providers on unknown input', () => {
    expect(() => getPreset('grok')).toThrow(/openai, anthropic, zai, kimi, custom/)
  })
})

describe('createProvider', () => {
  it('builds an OpenAI-compatible provider for zai using the preset base URL', () => {
    process.env.ZAI_API_KEY = 'k'
    const provider = createProvider(raw({ provider: 'zai' }))
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider)
    process.env.ZAI_API_KEY = ''
  })

  it('builds an Anthropic provider for anthropic', () => {
    process.env.ANTHROPIC_API_KEY = 'k'
    expect(createProvider(raw({ provider: 'anthropic' }))).toBeInstanceOf(AnthropicProvider)
    process.env.ANTHROPIC_API_KEY = ''
  })

  it('throws naming the missing env var', () => {
    delete process.env.OPENAI_API_KEY
    expect(() => createProvider(raw())).toThrow(/OPENAI_API_KEY/)
  })

  it('requires model and base-url for custom', () => {
    process.env.CUSTOM_API_KEY = 'k'
    expect(() => createProvider(raw({ provider: 'custom' }))).toThrow(/model/)
    expect(() => createProvider(raw({ provider: 'custom', model: 'llama3' }))).toThrow(/base-url/)
    expect(() =>
      createProvider(raw({ provider: 'custom', model: 'llama3', baseUrl: 'http://x/v1' })),
    ).toBeInstanceOf(OpenAICompatibleProvider)
    delete process.env.CUSTOM_API_KEY
  })
})

describe('OpenAICompatibleProvider', () => {
  it('requests json_object instead of json_schema', async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ choices: [{ message: { content: '{"findings":[]}' } }] })
    const provider = new OpenAICompatibleProvider(
      'glm-4.6',
      'k',
      'https://api.z.ai/api/paas/v4',
      { chat: { completions: { create } } } as unknown as OpenAI,
    )
    const result = await provider.complete('s', 'u')
    expect(result).toEqual([])
    const body = create.mock.calls[0][0] as Record<string, unknown>
    expect(body['response_format']).toEqual({ type: 'json_object' })
    expect(body['model']).toBe('glm-4.6')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- providers/registry.test`
Expected: FAIL — cannot resolve `../../src/providers/registry` and `openai-compatible`.

- [ ] **Step 3: Write the implementation**

`src/providers/openai-compatible.ts`:

```ts
import type OpenAI from 'openai'
import { OpenAIProvider } from './openai'

export class OpenAICompatibleProvider extends OpenAIProvider {
  protected override responseFormat(): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming['response_format'] {
    return { type: 'json_object' }
  }
}
```

`src/providers/registry.ts`:

```ts
import type { RawInputs } from '../config'
import { AnthropicProvider } from './anthropic'
import { OpenAICompatibleProvider } from './openai-compatible'
import { OpenAIProvider } from './openai'
import type { ReviewProvider } from './types'

export interface ProviderPreset {
  adapter: 'openai' | 'anthropic' | 'openai-compatible'
  defaultModel: string
  baseUrl?: string
  apiKeyEnv: string
  contextWindowTokens: number
}

export const PRESETS: Record<string, ProviderPreset> = {
  openai: {
    adapter: 'openai',
    defaultModel: 'gpt-4.1',
    apiKeyEnv: 'OPENAI_API_KEY',
    contextWindowTokens: 1000000,
  },
  anthropic: {
    adapter: 'anthropic',
    defaultModel: 'claude-sonnet-4-5',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    contextWindowTokens: 200000,
  },
  zai: {
    adapter: 'openai-compatible',
    defaultModel: 'glm-4.6',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    apiKeyEnv: 'ZAI_API_KEY',
    contextWindowTokens: 200000,
  },
  kimi: {
    adapter: 'openai-compatible',
    defaultModel: 'kimi-k2',
    baseUrl: 'https://api.moonshot.ai/v1',
    apiKeyEnv: 'KIMI_API_KEY',
    contextWindowTokens: 131072,
  },
  custom: {
    adapter: 'openai-compatible',
    defaultModel: '',
    apiKeyEnv: 'CUSTOM_API_KEY',
    contextWindowTokens: 128000,
  },
}

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderConfigError'
  }
}

export function getPreset(provider: string): ProviderPreset {
  const preset = PRESETS[provider]
  if (!preset) {
    throw new ProviderConfigError(
      `Unknown provider "${provider}". Supported: ${Object.keys(PRESETS).join(', ')}.`,
    )
  }
  return preset
}

export function createProvider(raw: RawInputs): ReviewProvider {
  const preset = getPreset(raw.provider)
  const model = raw.model || preset.defaultModel
  const baseUrl = raw.baseUrl || preset.baseUrl
  if (preset.adapter === 'openai-compatible') {
    if (!model) {
      throw new ProviderConfigError('The "model" input is required when provider is "custom".')
    }
    if (!baseUrl) {
      throw new ProviderConfigError('The "base-url" input is required when provider is "custom".')
    }
  }
  const apiKey = process.env[preset.apiKeyEnv]
  if (!apiKey) {
    throw new ProviderConfigError(
      `Missing API key for provider "${raw.provider}": set the ${preset.apiKeyEnv} environment variable.`,
    )
  }
  if (preset.adapter === 'anthropic') return new AnthropicProvider(model, apiKey)
  if (preset.adapter === 'openai') return new OpenAIProvider(model, apiKey)
  return new OpenAICompatibleProvider(model, apiKey, baseUrl as string)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- providers/registry.test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/openai-compatible.ts src/providers/registry.ts __tests__/providers/registry.test.ts
git commit -m "feat: OpenAI-compatible adapter and provider registry"
```

---

### Task 9: Comment filtering, summary body, posting

**Files:**
- Create: `src/comment.ts`
- Test: `__tests__/comment.test.ts`

**Interfaces:**
- Consumes: `Finding`, `DiffContext`, `ReviewConfig`, `SEVERITY_RANK`, `COMMENT_MARKER` (Task 2), `Octokit`
- Produces: `FilteredFindings` (`{ inline: Finding[]; summaryOnly: Finding[] }`), `filterFindings(findings: Finding[], diff: DiffContext, config: ReviewConfig): FilteredFindings`, `buildSummaryBody(filtered: FilteredFindings, diff: DiffContext, config: ReviewConfig): string`, `cleanupPreviousComments(octokit: Octokit, repo: { owner: string; repo: string }, prNumber: number): Promise<number>`, `postReview(octokit: Octokit, repo: { owner: string; repo: string }, prNumber: number, body: string, inline: Finding[]): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`__tests__/comment.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import type { Octokit } from '@octokit/core'
import {
  buildSummaryBody,
  cleanupPreviousComments,
  filterFindings,
  postReview,
} from '../src/comment'
import { COMMENT_MARKER, type DiffContext, type Finding, type ReviewConfig } from '../src/providers/types'

const config: ReviewConfig = {
  provider: 'openai',
  model: 'gpt-4.1',
  contextWindowTokens: 1000000,
  maxComments: 2,
  reviewStyle: 'high-signal',
  severityThreshold: 'suggestion',
}

const diff: DiffContext = {
  files: [
    { path: 'src/app.ts', patch: '@@ -1,4 +1,6 @@\n const a = 1\n+const b = 3\n+const c = eval("x")\n // done', commentableLines: [1, 2, 3, 4] },
  ],
  truncated: false,
  skipped: [],
  estimatedTokens: 10,
}

function finding(severity: Finding['severity'], file = 'src/app.ts', line = 2): Finding {
  return { file, line, severity, title: `${severity} issue`, body: `${severity} body` }
}

describe('filterFindings', () => {
  it('keeps anchored findings as inline and moves unanchored to summaryOnly', () => {
    const filtered = filterFindings(
      [finding('critical'), finding('warning', 'missing.ts', 1)],
      diff,
      config,
    )
    expect(filtered.inline.map((f) => f.severity)).toEqual(['critical'])
    expect(filtered.summaryOnly.map((f) => f.file)).toEqual(['missing.ts'])
  })

  it('moves findings with lines outside the diff to summaryOnly', () => {
    const filtered = filterFindings([finding('warning', 'src/app.ts', 999)], diff, config)
    expect(filtered.inline).toEqual([])
    expect(filtered.summaryOnly).toHaveLength(1)
  })

  it('drops findings below the severity threshold', () => {
    const filtered = filterFindings(
      [finding('suggestion')],
      diff,
      { ...config, severityThreshold: 'warning' },
    )
    expect(filtered.inline).toEqual([])
    expect(filtered.summaryOnly).toEqual([])
  })

  it('caps inline comments keeping highest severity first, overflow to summaryOnly', () => {
    const findings = [finding('suggestion', 'src/app.ts', 1), finding('warning'), finding('critical')]
    const filtered = filterFindings(findings, diff, config)
    expect(filtered.inline.map((f) => f.severity)).toEqual(['critical', 'warning'])
    expect(filtered.summaryOnly.map((f) => f.severity)).toEqual(['suggestion'])
  })
})

describe('buildSummaryBody', () => {
  it('returns an LGTM body when there are no findings', () => {
    const body = buildSummaryBody({ inline: [], summaryOnly: [] }, diff, config)
    expect(body).toContain(COMMENT_MARKER)
    expect(body.toLowerCase()).toContain('lgtm')
  })

  it('includes verdict counts, provider attribution, and a summary table', () => {
    const body = buildSummaryBody(
      { inline: [finding('critical')], summaryOnly: [finding('warning', 'other.ts', 9)] },
      diff,
      config,
    )
    expect(body).toContain('1 critical')
    expect(body).toContain('gpt-4.1')
    expect(body).toContain('other.ts#L9')
    expect(body).toContain('warning issue')
  })

  it('warns about truncation and skipped files', () => {
    const body = buildSummaryBody(
      { inline: [], summaryOnly: [] },
      { ...diff, truncated: true, skipped: ['logo.png'] },
      config,
    )
    expect(body).toContain('truncated')
    expect(body).toContain('logo.png')
  })
})

describe('cleanupPreviousComments', () => {
  it('deletes only review comments containing the marker', async () => {
    const deleteReviewComment = vi.fn()
    const paginate = vi
      .fn()
      .mockResolvedValue([
        { id: 1, body: `${COMMENT_MARKER}\nold` },
        { id: 2, body: 'human comment' },
      ])
    const octokit = {
      paginate,
      rest: { pulls: { deleteReviewComment } },
    } as unknown as Octokit
    const deleted = await cleanupPreviousComments(octokit, { owner: 'o', repo: 'r' }, 5)
    expect(deleted).toBe(1)
    expect(deleteReviewComment).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      comment_id: 1,
    })
  })
})

describe('postReview', () => {
  it('posts one COMMENT review with RIGHT-side inline comments', async () => {
    const createReview = vi.fn()
    const octokit = {
      rest: { pulls: { createReview } },
    } as unknown as Octokit
    await postReview(octokit, { owner: 'o', repo: 'r' }, 5, 'body', [finding('critical')])
    expect(createReview).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      pull_number: 5,
      event: 'COMMENT',
      body: 'body',
      comments: [
        {
          path: 'src/app.ts',
          line: 2,
          side: 'RIGHT',
          body: expect.stringContaining(COMMENT_MARKER),
        },
      ],
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- comment.test`
Expected: FAIL — cannot resolve `../src/comment`.

- [ ] **Step 3: Write the implementation**

`src/comment.ts`:

```ts
import type { Octokit } from '@octokit/core'
import {
  COMMENT_MARKER,
  SEVERITY_RANK,
  type DiffContext,
  type Finding,
  type ReviewConfig,
} from './providers/types'

export interface FilteredFindings {
  inline: Finding[]
  summaryOnly: Finding[]
}

export function filterFindings(
  findings: Finding[],
  diff: DiffContext,
  config: ReviewConfig,
): FilteredFindings {
  const inScope = findings.filter(
    (f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[config.severityThreshold],
  )
  const anchored: Finding[] = []
  const unanchored: Finding[] = []
  for (const f of inScope) {
    const file = diff.files.find((x) => x.path === f.file)
    if (file && file.commentableLines.includes(f.line)) anchored.push(f)
    else unanchored.push(f)
  }
  anchored.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
  const inline = anchored.slice(0, config.maxComments)
  const overflow = anchored.slice(config.maxComments)
  return { inline, summaryOnly: [...unanchored, ...overflow] }
}

export function buildSummaryBody(
  filtered: FilteredFindings,
  diff: DiffContext,
  config: ReviewConfig,
): string {
  const all = [...filtered.inline, ...filtered.summaryOnly]
  const lines: string[] = [COMMENT_MARKER, '## AI Code Review', '']
  lines.push(`Provider: ${config.provider} | Model: ${config.model}`, '')
  if (all.length === 0) {
    lines.push('**LGTM — no issues found.**')
  } else {
    const count = (s: Finding['severity']) =>
      all.filter((f) => f.severity === s).length
    lines.push(
      `**Verdict:** ${count('critical')} critical | ${count('warning')} warning | ${count('suggestion')} suggestion`,
      '',
    )
    if (filtered.summaryOnly.length > 0) {
      lines.push(
        'Findings that could not be posted inline:',
        '',
        '| Severity | Location | Issue |',
        '| --- | --- | --- |',
        ...filtered.summaryOnly.map(
          (f) => `| ${f.severity} | ${f.file}#L${f.line} | ${f.title} |`,
        ),
        '',
      )
    }
  }
  if (diff.skipped.length > 0) {
    lines.push(`> Skipped (not reviewable or out of scope): ${diff.skipped.join(', ')}`)
  }
  if (diff.truncated) {
    lines.push('> Diff was truncated to fit the model context window.')
  }
  return lines.join('\n')
}

export async function cleanupPreviousComments(
  octokit: Octokit,
  repo: { owner: string; repo: string },
  prNumber: number,
): Promise<number> {
  const comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner: repo.owner,
    repo: repo.repo,
    pull_number: prNumber,
    per_page: 100,
  })
  let deleted = 0
  for (const comment of comments) {
    if (comment.body?.includes(COMMENT_MARKER)) {
      await octokit.rest.pulls.deleteReviewComment({
        owner: repo.owner,
        repo: repo.repo,
        comment_id: comment.id,
      })
      deleted++
    }
  }
  return deleted
}

export async function postReview(
  octokit: Octokit,
  repo: { owner: string; repo: string },
  prNumber: number,
  body: string,
  inline: Finding[],
): Promise<void> {
  await octokit.rest.pulls.createReview({
    owner: repo.owner,
    repo: repo.repo,
    pull_number: prNumber,
    event: 'COMMENT',
    body,
    comments: inline.map((f) => ({
      path: f.file,
      line: f.line,
      side: 'RIGHT' as const,
      body: `${COMMENT_MARKER}\n**[${f.severity.toUpperCase()}] ${f.title}**\n\n${f.body}`,
    })),
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- comment.test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/comment.ts __tests__/comment.test.ts
git commit -m "feat: finding filtering, summary body, review posting and stale cleanup"
```

---

### Task 10: Review orchestration

**Files:**
- Create: `src/review.ts`
- Test: `__tests__/review.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–9
- Produces: `ReviewDeps` (`{ octokit: Octokit; repo: { owner: string; repo: string }; prNumber: number; pr: { title: string; body: string }; raw: RawInputs; repoConfig: RepoConfig; provider?: ReviewProvider }`), `ReviewResult` (`{ findingsCount: number; inlineCount: number; summaryOnlyCount: number }`), `runReview(deps: ReviewDeps): Promise<ReviewResult>`

- [ ] **Step 1: Write the failing tests**

`__tests__/review.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import type { Octokit } from '@octokit/core'
import { runReview } from '../src/review'
import type { Finding, ReviewProvider } from '../src/providers/types'
import type { RawInputs, RepoConfig } from '../src/config'

const SAMPLE_PATCH =
  '@@ -1,4 +1,6 @@\n const a = 1\n-const b = 2\n+const b = 3\n+const c = eval("userInput")\n // done'

const finding: Finding = {
  file: 'src/app.ts',
  line: 3,
  severity: 'critical',
  title: 'Remote code execution',
  body: 'eval() on user input.',
}

function fakeProvider(findings: Finding[]): ReviewProvider {
  return {
    complete: vi.fn().mockResolvedValue(findings),
  }
}

function fakeOctokit() {
  const createReview = vi.fn()
  const deleteReviewComment = vi.fn()
  const octokit = {
    paginate: vi.fn().mockImplementation((fn: unknown, args: Record<string, unknown>) => {
      const name = (fn as { endpoint: { route: string } } | undefined)?.endpoint?.route ?? ''
      if (name.includes('listFiles')) {
        return [{ filename: 'src/app.ts', patch: SAMPLE_PATCH, additions: 2, deletions: 1 }]
      }
      if (name.includes('listReviewComments')) {
        return [{ id: 11, body: '<!-- ai-code-review-action -->\nold' }]
      }
      return []
    }),
    rest: {
      pulls: {
        createReview,
        deleteReviewComment,
        listFiles: { endpoint: { route: 'GET /repos/{owner}/{repo}/pulls/{pull_number}/files' } },
        listReviewComments: {
          endpoint: { route: 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments' },
        },
      },
    },
  }
  return { octokit: octokit as unknown as Octokit, createReview, deleteReviewComment }
}

const raw: RawInputs = {
  provider: 'openai',
  model: 'gpt-4.1',
  baseUrl: '',
  contextWindow: '128000',
  githubToken: 't',
  configPath: '.ai-review.yml',
}

const repoConfig: RepoConfig = {
  paths: ['**/*'],
  pathsIgnore: [],
  maxComments: 20,
  reviewStyle: 'high-signal',
  severityThreshold: 'suggestion',
}

function deps(provider: ReviewProvider, octokit: Octokit) {
  return {
    octokit,
    repo: { owner: 'o', repo: 'r' },
    prNumber: 5,
    pr: { title: 'Add feature', body: 'desc' },
    raw,
    repoConfig,
    provider,
  }
}

describe('runReview', () => {
  it('posts a review with inline comments for anchored findings and cleans stale ones', async () => {
    const { octokit, createReview, deleteReviewComment } = fakeOctokit()
    const result = await runReview(deps(fakeProvider([finding]), octokit))
    expect(result).toEqual({ findingsCount: 1, inlineCount: 1, summaryOnlyCount: 0 })
    expect(deleteReviewComment).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      comment_id: 11,
    })
    expect(createReview).toHaveBeenCalledTimes(1)
    const review = createReview.mock.calls[0][0]
    expect(review.event).toBe('COMMENT')
    expect(review.comments[0].path).toBe('src/app.ts')
    expect(review.comments[0].line).toBe(3)
    expect(review.body).toContain('1 critical')
  })

  it('posts an LGTM summary when the provider returns no findings', async () => {
    const { octokit, createReview } = fakeOctokit()
    const result = await runReview(deps(fakeProvider([]), octokit))
    expect(result).toEqual({ findingsCount: 0, inlineCount: 0, summaryOnlyCount: 0 })
    expect(createReview.mock.calls[0][0].body.toLowerCase()).toContain('lgtm')
  })

  it('moves unanchored findings to the summary table instead of failing', async () => {
    const { octokit, createReview } = fakeOctokit()
    const stray = { ...finding, file: 'nope.ts', line: 42 }
    const result = await runReview(deps(fakeProvider([stray]), octokit))
    expect(result).toEqual({ findingsCount: 1, inlineCount: 0, summaryOnlyCount: 1 })
    expect(createReview.mock.calls[0][0].comments).toEqual([])
    expect(createReview.mock.calls[0][0].body).toContain('nope.ts#L42')
  })

  it('posts a note when no reviewable files remain after filtering', async () => {
    const createReview = vi.fn()
    const octokit = {
      paginate: vi.fn().mockResolvedValue([{ filename: 'logo.png', additions: 1, deletions: 0 }]),
      rest: { pulls: { createReview } },
    } as unknown as Octokit
    const result = await runReview(deps(fakeProvider([]), octokit))
    expect(result.findingsCount).toBe(0)
    expect(createReview).toHaveBeenCalledTimes(1)
    expect(createReview.mock.calls[0][0].body).toContain('No reviewable files')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- review.test`
Expected: FAIL — cannot resolve `../src/review`.

- [ ] **Step 3: Write the implementation**

`src/review.ts`:

```ts
import type { Octokit } from '@octokit/core'
import { resolveConfig, type RawInputs, type RepoConfig } from './config'
import {
  buildDiffContext,
  fetchPrFiles,
} from './diff'
import {
  buildSummaryBody,
  cleanupPreviousComments,
  filterFindings,
  postReview,
} from './comment'
import { buildSystemPrompt, buildUserPrompt } from './prompt'
import { createProvider, getPreset } from './providers/registry'
import { COMMENT_MARKER, type ReviewProvider } from './providers/types'

export interface ReviewDeps {
  octokit: Octokit
  repo: { owner: string; repo: string }
  prNumber: number
  pr: { title: string; body: string }
  raw: RawInputs
  repoConfig: RepoConfig
  provider?: ReviewProvider
}

export interface ReviewResult {
  findingsCount: number
  inlineCount: number
  summaryOnlyCount: number
}

export async function runReview(deps: ReviewDeps): Promise<ReviewResult> {
  const preset = getPreset(deps.raw.provider)
  const config = resolveConfig(deps.raw, deps.repoConfig, preset)
  const provider = deps.provider ?? createProvider(deps.raw)

  const files = await fetchPrFiles(deps.octokit, deps.repo, deps.prNumber)
  const diff = buildDiffContext(files, deps.repoConfig, config.contextWindowTokens)

  let inline: ReturnType<typeof filterFindings>['inline'] = []
  let summaryOnly: ReturnType<typeof filterFindings>['summaryOnly'] = []
  let body: string

  if (diff.files.length === 0) {
    body = [
      COMMENT_MARKER,
      '## AI Code Review',
      '',
      'No reviewable files after applying filters (binary or ignored files only).',
      ...(diff.skipped.length ? [`> Skipped: ${diff.skipped.join(', ')}`] : []),
    ].join('\n')
  } else {
    const system = buildSystemPrompt(config)
    const user = buildUserPrompt(diff, deps.pr)
    const findings = await provider.complete(system, user)
    const filtered = filterFindings(findings, diff, config)
    inline = filtered.inline
    summaryOnly = filtered.summaryOnly
    body = buildSummaryBody(filtered, diff, config)
  }

  await cleanupPreviousComments(deps.octokit, deps.repo, deps.prNumber)
  await postReview(deps.octokit, deps.repo, deps.prNumber, body, inline)

  return {
    findingsCount: inline.length + summaryOnly.length,
    inlineCount: inline.length,
    summaryOnlyCount: summaryOnly.length,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- review.test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review.ts __tests__/review.test.ts
git commit -m "feat: review orchestration pipeline"
```

---

### Task 11: Entrypoint, build, committed dist

**Files:**
- Create: `src/main.ts`
- Modify: `dist/` (generated, committed)
- Test: `__tests__/main.test.ts` (unit-test the error mapping helper), plus a manual `node dist/index.js` smoke run

**Interfaces:**
- Consumes: `readRawInputs`, `loadRepoConfig`, `ConfigError` (Task 3), `runReview` (Task 10), `ProviderConfigError` (Task 8), `ProviderError` (Task 2), `@actions/core`, `@actions/github`
- Produces: the runnable action entrypoint; action outputs `findings-count`, `inline-comments`; `describeError(err: unknown): string`

- [ ] **Step 1: Write the failing test**

`__tests__/main.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { describeError } from '../src/main'
import { ConfigError } from '../src/providers/types'
import { ProviderConfigError } from '../src/providers/registry'

describe('describeError', () => {
  it('returns the message directly for known error types', () => {
    expect(describeError(new ConfigError('bad config'))).toBe('bad config')
    expect(describeError(new ProviderConfigError('bad provider'))).toBe('bad provider')
  })

  it('returns the raw response for provider JSON failures', () => {
    const err = new Error('nope')
    err.name = 'ProviderError'
    expect(describeError(err)).toBe('nope')
  })

  it('labels unexpected errors', () => {
    expect(describeError(new Error('boom'))).toContain('Unexpected error')
    expect(describeError('str')).toContain('Unexpected error')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- main.test`
Expected: FAIL — cannot resolve `../src/main`.

- [ ] **Step 3: Write the implementation**

`src/main.ts`:

```ts
import * as core from '@actions/core'
import { context, getOctokit } from '@actions/github'
import { loadRepoConfig, readRawInputs } from './config'
import { runReview } from './review'
import { ProviderConfigError } from './providers/registry'
import { ConfigError, ProviderError } from './providers/types'

export function describeError(err: unknown): string {
  if (
    err instanceof ConfigError ||
    err instanceof ProviderConfigError ||
    err instanceof ProviderError ||
    (err instanceof Error && err.name === 'ProviderError')
  ) {
    return err.message
  }
  return `Unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`
}

async function run(): Promise<void> {
  const pr = context.payload.pull_request
  if (!pr) {
    core.info('Not a pull request event; nothing to do.')
    return
  }
  const raw = readRawInputs()
  const octokit = getOctokit(raw.githubToken || context.token)
  const repoConfig = await loadRepoConfig(raw.configPath)
  const result = await runReview({
    octokit,
    repo: context.repo,
    prNumber: pr.number,
    pr: { title: pr.title ?? '', body: pr.body ?? '' },
    raw,
    repoConfig,
  })
  core.setOutput('findings-count', String(result.findingsCount))
  core.setOutput('inline-comments', String(result.inlineCount))
}

run().catch((err) => {
  core.setFailed(describeError(err))
})
```

- [ ] **Step 4: Run tests, build, and smoke-check the bundle**

Run: `npm test && npm run lint && npm run typecheck && npm run build`
Expected: all PASS, `dist/index.js` produced.

Smoke check outside GitHub (must exit 0 without a PR context):

Run: `node dist/index.js; echo "exit=$?"`
Expected: prints `Not a pull request event; nothing to do.` (via core.info) and `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts __tests__/main.test.ts dist/
git commit -m "feat: action entrypoint with ncc bundle"
```

---

### Task 12: README and LICENSE

**Files:**
- Create: `README.md`, `LICENSE`

**Interfaces:**
- Consumes: final behavior of Tasks 1–11
- Produces: marketplace-ready documentation

- [ ] **Step 1: Write README.md**

Content must cover (write full markdown, no placeholders):

- Title, one-paragraph description, and how it works (inline comments + summary review)
- Quick start workflow example:

```yaml
name: AI Code Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
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

- One provider table: `provider` value, default model, required env var (OPENAI_API_KEY / ANTHROPIC_API_KEY / ZAI_API_KEY / KIMI_API_KEY / CUSTOM_API_KEY), notes for `custom` (needs `model`, `base-url`, optional `context-window`)
- Inputs reference table (provider, model, base-url, context-window, github-token, config-path) copied from `action.yml`
- Outputs (`findings-count`, `inline-comments`)
- `.ai-review.yml` reference with the example from the spec (`paths`, `paths-ignore`, `max-comments`, `review-style`, `severity-threshold`, `custom-instructions`) and a note that the file is optional
- Behavior notes: one review per push, previous bot comments are deleted on new runs, diff truncation for large PRs, empty-findings LGTM
- Example for z.ai (`provider: zai`, `ZAI_API_KEY`) and Kimi (`provider: kimi`, `KIMI_API_KEY`)
- Development section: `npm ci`, `npm test`, `npm run build`, note that `dist/` is committed and CI enforces freshness

- [ ] **Step 2: Write LICENSE**

MIT license text, copyright `(c) 2026 yasserk41`.

- [ ] **Step 3: Verify and commit**

Run: `npm test && npm run build && git diff --exit-code dist/`
Expected: PASS (no rebuild drift).

```bash
git add README.md LICENSE
git commit -m "docs: marketplace README and MIT license"
```

---

## Plan Self-Review (completed)

- **Spec coverage:** providers + registry (Tasks 6–8), triggers (workflow example in Task 12 README, guarded entry in Task 11), inline + summary posting with stale cleanup (Task 9), inputs + `.ai-review.yml` with zod errors naming keys (Task 3), whole-diff single call with 70%/2k safety valve (Tasks 4, 10), structured output both SDKs (Tasks 6–7), repair retry (Tasks 6–7), unanchored → summary (Tasks 9–10), LGTM path (Task 9), CI with dist freshness check (Task 1), marketplace docs + license (Task 12). No spec requirement left without a task.
- **Placeholders:** none; every step carries concrete code or exact content requirements.
- **Type consistency:** `RawInputs`/`RepoConfig` (Task 3) consumed verbatim in Tasks 8 and 10; `DiffContext`/`FileDiff` (Task 2) verbatim in Tasks 4, 5, 9, 10; `OpenAIProvider` subclass hook (`responseFormat`) defined in Task 6 and overridden in Task 8; `parseCommentableLines` line numbering agrees between Task 4 fixture ([1,2,3,4]) and Task 9/10 fixtures.
