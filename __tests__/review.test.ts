import { describe, it, expect, vi } from 'vitest'
import type { Octokit } from '@octokit/core' with { 'resolution-mode': 'import' }
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
    adjudicate: vi.fn(),
  }
}

function fakeOctokit(threadNodes: unknown[] = []) {
  const createReview = vi.fn()
  const createReplyForReviewComment = vi.fn().mockResolvedValue({})
  const graphql = vi.fn().mockImplementation((query: string) => {
    if (query.includes('resolveReviewThread')) {
      return Promise.resolve({ resolveReviewThread: { thread: { id: 'resolved' } } })
    }
    return Promise.resolve({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: threadNodes,
          },
        },
      },
    })
  })
  const octokit = {
    paginate: vi.fn().mockImplementation((fn: unknown) => {
      const name = (fn as { endpoint: { route: string } } | undefined)?.endpoint?.route ?? ''
      if (name.includes('files') || name.includes('listFiles')) {
        return [{ filename: 'src/app.ts', patch: SAMPLE_PATCH, additions: 2, deletions: 1 }]
      }
      return []
    }),
    graphql,
    rest: {
      pulls: {
        createReview,
        createReplyForReviewComment,
        listFiles: { endpoint: { route: 'GET /repos/{owner}/{repo}/pulls/{pull_number}/files' } },
      },
    },
  }
  return {
    octokit: octokit as unknown as Octokit,
    createReview,
    createReplyForReviewComment,
    graphql,
  }
}

const raw: RawInputs = {
  provider: 'openai',
  model: 'gpt-4.1',
  baseUrl: '',
  contextWindow: '128000',
  githubToken: 't',
  configPath: '.ai-review.yml',
  verdict: 'comment',
  requestChangesOn: 'critical',
  adjudicateReplies: true,
}

const repoConfig: RepoConfig = {
  paths: ['**/*'],
  pathsIgnore: [],
  maxComments: 20,
  reviewStyle: 'high-signal',
  severityThreshold: 'suggestion',
}

function deps(provider: ReviewProvider, octokit: Octokit, rawOverrides: Partial<RawInputs> = {}) {
  return {
    octokit,
    repo: { owner: 'o', repo: 'r' },
    prNumber: 5,
    pr: { title: 'Add feature', body: 'desc' },
    raw: { ...raw, ...rawOverrides },
    repoConfig,
    provider,
  }
}

describe('runReview', () => {
  it('posts a review with inline comments for anchored findings and resolves vanished threads', async () => {
    const vanishedThread = {
      id: 't-vanished',
      isResolved: false,
      comments: {
        nodes: [
          {
            databaseId: 11,
            body: '<!-- ai-code-review-action -->\nold issue',
            path: 'src/app.ts',
            line: 99,
            originalLine: 99,
          },
        ],
      },
    }
    const { octokit, createReview, createReplyForReviewComment, graphql } = fakeOctokit([vanishedThread])
    const result = await runReview(deps(fakeProvider([finding]), octokit))
    expect(result).toEqual({ findingsCount: 1, inlineCount: 1, summaryOnlyCount: 0, verdict: 'commented', resolvedThreads: 1 })
    expect(createReplyForReviewComment).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      pull_number: 5,
      comment_id: 11,
      body: expect.stringContaining('Fix verified'),
    })
    expect(graphql).toHaveBeenCalledWith(
      expect.stringContaining('resolveReviewThread'),
      { threadId: 't-vanished' },
    )
    expect(createReview).toHaveBeenCalledTimes(1)
    const review = createReview.mock.calls[0][0]
    expect(review.event).toBe('COMMENT')
    expect(review.comments[0].path).toBe('src/app.ts')
    expect(review.comments[0].line).toBe(3)
    expect(review.body).toContain('1 critical')
  })

  it('continues posting the review when thread resolution is rejected by permissions', async () => {
    const vanishedThread = {
      id: 't-forbidden',
      isResolved: false,
      comments: {
        nodes: [
          {
            databaseId: 13,
            body: '<!-- ai-code-review-action -->\nold issue',
            path: 'src/app.ts',
            line: 99,
            originalLine: 99,
          },
        ],
      },
    }
    const { octokit, createReview, graphql } = fakeOctokit([vanishedThread])
    graphql.mockImplementation((query: string) => {
      if (query.includes('resolveReviewThread')) {
        return Promise.reject(new Error('Resource not accessible by integration'))
      }
      return Promise.resolve({
        repository: {
          pullRequest: {
            reviewThreads: { nodes: [vanishedThread] },
          },
        },
      })
    })
    const result = await runReview(deps(fakeProvider([finding]), octokit))
    expect(result).toEqual({ findingsCount: 1, inlineCount: 1, summaryOnlyCount: 0, verdict: 'commented', resolvedThreads: 0 })
    expect(createReview).toHaveBeenCalledTimes(1)
    expect(createReview.mock.calls[0][0].comments[0].path).toBe('src/app.ts')
  })

  it('does not duplicate inline comment when finding persists on the same line', async () => {
    const persistedThread = {
      id: 't-persisted',
      isResolved: false,
      comments: {
        nodes: [
          {
            databaseId: 12,
            body: '<!-- ai-code-review-action -->\nexisting issue',
            path: 'src/app.ts',
            line: 3,
            originalLine: 3,
          },
        ],
      },
    }
    const { octokit, createReview, createReplyForReviewComment } = fakeOctokit([persistedThread])
    const result = await runReview(deps(fakeProvider([finding]), octokit))
    expect(result.resolvedThreads).toBe(0)
    expect(createReplyForReviewComment).not.toHaveBeenCalled()
    expect(createReview).toHaveBeenCalledTimes(1)
    expect(createReview.mock.calls[0][0].comments).toEqual([])
  })

  it('posts an LGTM summary when the provider returns no findings', async () => {
    const { octokit, createReview } = fakeOctokit()
    const result = await runReview(deps(fakeProvider([]), octokit))
    expect(result).toEqual({ findingsCount: 0, inlineCount: 0, summaryOnlyCount: 0, verdict: 'commented', resolvedThreads: 0 })
    expect(createReview.mock.calls[0][0].body.toLowerCase()).toContain('lgtm')
  })

  it('moves unanchored findings to the summary table instead of failing', async () => {
    const { octokit, createReview } = fakeOctokit()
    const stray = { ...finding, file: 'nope.ts', line: 42 }
    const result = await runReview(deps(fakeProvider([stray]), octokit))
    expect(result).toEqual({ findingsCount: 1, inlineCount: 0, summaryOnlyCount: 1, verdict: 'commented', resolvedThreads: 0 })
    expect(createReview.mock.calls[0][0].comments).toEqual([])
    expect(createReview.mock.calls[0][0].body).toContain('nope.ts#L42')
  })

  it('posts a note when no reviewable files remain after filtering', async () => {
    const createReview = vi.fn()
    const graphql = vi.fn().mockResolvedValue({
      repository: { pullRequest: { reviewThreads: { nodes: [] } } },
    })
    const octokit = {
      paginate: vi.fn().mockResolvedValue([{ filename: 'logo.png', additions: 1, deletions: 0 }]),
      graphql,
      rest: { pulls: { createReview, createReplyForReviewComment: vi.fn() } },
    } as unknown as Octokit
    const result = await runReview(deps(fakeProvider([]), octokit))
    expect(result.findingsCount).toBe(0)
    expect(result.verdict).toBe('commented')
    expect(result.resolvedThreads).toBe(0)
    expect(createReview).toHaveBeenCalledTimes(1)
    expect(createReview.mock.calls[0][0].body).toContain('No reviewable files')
  })

  it('submits REQUEST_CHANGES and returns verdict changes-requested for critical findings in auto mode', async () => {
    const { octokit, createReview } = fakeOctokit()
    const result = await runReview(deps(fakeProvider([finding]), octokit, { verdict: 'auto' }))
    expect(result).toEqual({ findingsCount: 1, inlineCount: 1, summaryOnlyCount: 0, verdict: 'changes-requested', resolvedThreads: 0 })
    expect(createReview).toHaveBeenCalledTimes(1)
    const review = createReview.mock.calls[0][0]
    expect(review.event).toBe('REQUEST_CHANGES')
    expect(review.comments[0].path).toBe('src/app.ts')
  })

  it('submits APPROVE and returns verdict approved for zero findings in auto mode', async () => {
    const { octokit, createReview } = fakeOctokit()
    const result = await runReview(deps(fakeProvider([]), octokit, { verdict: 'auto' }))
    expect(result).toEqual({ findingsCount: 0, inlineCount: 0, summaryOnlyCount: 0, verdict: 'approved', resolvedThreads: 0 })
    expect(createReview).toHaveBeenCalledTimes(1)
    const review = createReview.mock.calls[0][0]
    expect(review.event).toBe('APPROVE')
    expect(review.comments).toEqual([])
  })

  it('falls back to COMMENT when GitHub rejects token-based approvals', async () => {
    const { octokit, createReview } = fakeOctokit()
    createReview
      .mockRejectedValueOnce(new Error('HttpError: Unprocessable Entity: "GitHub Actions is not permitted to approve pull requests."'))
      .mockResolvedValueOnce({})
    const result = await runReview(deps(fakeProvider([]), octokit, { verdict: 'auto' }))
    expect(result).toEqual({ findingsCount: 0, inlineCount: 0, summaryOnlyCount: 0, verdict: 'approved', resolvedThreads: 0 })
    expect(createReview).toHaveBeenCalledTimes(2)
    expect(createReview.mock.calls[0][0].event).toBe('APPROVE')
    expect(createReview.mock.calls[1][0].event).toBe('COMMENT')
  })
})
