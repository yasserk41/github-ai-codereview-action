import { minimatch } from 'minimatch'
import type { Octokit } from '@octokit/core' with { 'resolution-mode': 'import' }
import type { DiffContext, FileDiff } from './providers/types'
import type { RepoConfig } from './config'

export interface RawFile {
  filename: string
  patch?: string
  additions: number
  deletions: number
}

interface OctokitWithRest {
  paginate: (
    fn: unknown,
    parameters: { owner: string; repo: string; pull_number: number; per_page: number },
  ) => Promise<RawFile[]>
  rest?: {
    pulls?: {
      listFiles?: unknown
    }
  }
}

export async function fetchPrFiles(
  octokit: Octokit,
  repo: { owner: string; repo: string },
  prNumber: number,
): Promise<RawFile[]> {
  const client = octokit as unknown as OctokitWithRest
  return client.paginate(
    client.rest?.pulls?.listFiles ?? 'GET /repos/{owner}/{repo}/pulls/{pull_number}/files',
    {
      owner: repo.owner,
      repo: repo.repo,
      pull_number: prNumber,
      per_page: 100,
    },
  )
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
  config: Pick<RepoConfig, 'paths' | 'pathsIgnore'>,
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
