import { describe, it, expect, vi } from 'vitest'
import type { Octokit } from '@octokit/core' with { 'resolution-mode': 'import' }
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
