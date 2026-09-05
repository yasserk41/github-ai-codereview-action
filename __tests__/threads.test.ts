import { describe, it, expect, vi } from 'vitest'
import type { Octokit } from '@octokit/core' with { 'resolution-mode': 'import' }
import {
  planReconciliation,
  getBotThreads,
  resolveThread,
  replyToComment,
  RESOLVE_REPLY_BODY,
  type BotThread,
} from '../src/threads'
import { COMMENT_MARKER, type Finding } from '../src/providers/types'

describe('planReconciliation', () => {
  it('suppresses matched finding and keeps thread unresolved', () => {
    const thread: BotThread = {
      threadId: 't1',
      isResolved: false,
      path: 'src/index.ts',
      line: 10,
      firstCommentId: 101,
    }
    const finding: Finding = {
      file: 'src/index.ts',
      line: 10,
      severity: 'critical',
      title: 'Bug',
      body: 'Details',
    }
    const result = planReconciliation([thread], [finding])
    expect(result.toResolve).toEqual([])
    expect(result.suppress).toEqual(['src/index.ts:10'])
  })

  it('marks unmatched thread to be resolved and does not suppress finding', () => {
    const thread: BotThread = {
      threadId: 't1',
      isResolved: false,
      path: 'src/old.ts',
      line: 5,
      firstCommentId: 101,
    }
    const finding: Finding = {
      file: 'src/new.ts',
      line: 20,
      severity: 'warning',
      title: 'Warning',
      body: 'Details',
    }
    const result = planReconciliation([thread], [finding])
    expect(result.toResolve).toEqual([thread])
    expect(result.suppress).toEqual([])
  })

  it('resolves thread when code change causes line-shift', () => {
    const thread: BotThread = {
      threadId: 't1',
      isResolved: false,
      path: 'src/index.ts',
      line: 10,
      firstCommentId: 101,
    }
    const finding: Finding = {
      file: 'src/index.ts',
      line: 15,
      severity: 'critical',
      title: 'Shifted Bug',
      body: 'Details',
    }
    const result = planReconciliation([thread], [finding])
    expect(result.toResolve).toEqual([thread])
    expect(result.suppress).toEqual([])
  })
})

describe('getBotThreads', () => {
  it('maps GraphQL fixture filtering resolved threads, using line ?? originalLine, and filtering non-bot threads', async () => {
    const graphqlFixture = {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: 't-resolved',
                isResolved: true,
                comments: {
                  nodes: [
                    {
                      databaseId: 1,
                      body: `${COMMENT_MARKER}\nold issue`,
                      path: 'src/a.ts',
                      line: 10,
                      originalLine: 10,
                    },
                  ],
                },
              },
              {
                id: 't-human',
                isResolved: false,
                comments: {
                  nodes: [
                    {
                      databaseId: 2,
                      body: 'looks good to me',
                      path: 'src/b.ts',
                      line: 20,
                      originalLine: 20,
                    },
                  ],
                },
              },
              {
                id: 't-bot-with-line',
                isResolved: false,
                comments: {
                  nodes: [
                    {
                      databaseId: 3,
                      body: `${COMMENT_MARKER}\nbot issue`,
                      path: 'src/c.ts',
                      line: 30,
                      originalLine: 25,
                    },
                  ],
                },
              },
              {
                id: 't-bot-with-original-line',
                isResolved: false,
                comments: {
                  nodes: [
                    {
                      databaseId: 4,
                      body: `some context\n${COMMENT_MARKER}\nbot issue`,
                      path: 'src/d.ts',
                      line: null,
                      originalLine: 40,
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    }

    const graphql = vi.fn().mockResolvedValue(graphqlFixture)
    const octokit = { graphql } as unknown as Octokit

    const threads = await getBotThreads(octokit, { owner: 'o', repo: 'r' }, 42)

    expect(graphql).toHaveBeenCalledWith(
      expect.stringContaining('reviewThreads'),
      { owner: 'o', repo: 'r', prNumber: 42 },
    )
    expect(threads).toEqual([
      {
        threadId: 't-bot-with-line',
        isResolved: false,
        path: 'src/c.ts',
        line: 30,
        firstCommentId: 3,
      },
      {
        threadId: 't-bot-with-original-line',
        isResolved: false,
        path: 'src/d.ts',
        line: 40,
        firstCommentId: 4,
      },
    ])
  })
})

describe('resolveThread', () => {
  it('calls octokit.graphql with mutation resolveReviewThread and threadId', async () => {
    const graphql = vi.fn().mockResolvedValue({})
    const octokit = { graphql } as unknown as Octokit

    await resolveThread(octokit, 't-123')

    expect(graphql).toHaveBeenCalledWith(
      expect.stringContaining('resolveReviewThread'),
      { threadId: 't-123' },
    )
  })
})

describe('replyToComment', () => {
  it('calls pulls.createReplyForReviewComment with expected arguments', async () => {
    const createReplyForReviewComment = vi.fn().mockResolvedValue({})
    const octokit = {
      rest: {
        pulls: {
          createReplyForReviewComment,
        },
      },
    } as unknown as Octokit

    await replyToComment(
      octokit,
      { owner: 'test-owner', repo: 'test-repo' },
      7,
      12345,
      RESOLVE_REPLY_BODY,
    )

    expect(createReplyForReviewComment).toHaveBeenCalledWith({
      owner: 'test-owner',
      repo: 'test-repo',
      pull_number: 7,
      comment_id: 12345,
      body: '<!-- ai-code-review-action -->\nFix verified — this issue was not flagged in the latest review. Auto-resolving.',
    })
  })
})
