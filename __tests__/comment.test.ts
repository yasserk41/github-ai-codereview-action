import { describe, it, expect, vi } from 'vitest'
import type { Octokit } from '@octokit/core' with { 'resolution-mode': 'import' }
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
