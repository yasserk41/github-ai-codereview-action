import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as core from '@actions/core'
import type { Octokit } from '@octokit/core' with { 'resolution-mode': 'import' }
import {
  buildAdjudicationPrompts,
  fetchFileWindow,
  fetchFilePatch,
  runReplyReview,
  type ReplyDeps,
} from '../src/reply'
import { COMMENT_MARKER, type ReviewProvider } from '../src/providers/types'
import type { ThreadComment } from '../src/threads'

vi.mock('@actions/core', () => ({
  warning: vi.fn(),
  info: vi.fn(),
}))

describe('buildAdjudicationPrompts', () => {
  const root: ThreadComment = {
    id: 1,
    author: 'bot',
    body: `${COMMENT_MARKER}\nPotential null pointer dereference here.`,
    path: 'src/handler.ts',
    line: 45,
    originalLine: null,
  }
  const discussion: ThreadComment[] = [
    {
      id: 2,
      author: 'alice',
      body: 'I added an early return above so this cannot be null.',
      path: 'src/handler.ts',
      line: 45,
      originalLine: null,
    },
    {
      id: 3,
      author: 'bob',
      body: 'Verified, checked the caller too.',
      path: 'src/handler.ts',
      line: 45,
      originalLine: null,
    },
  ]
  const fileContext = 'function handle(req) {\n  if (!req) return\n  req.process()\n}'
  const patch = '@@ -40,6 +40,7 @@\n+  if (!req) return\n   req.process()'

  it('includes system instructions and JSON contract', () => {
    const { system } = buildAdjudicationPrompts(root, discussion, fileContext, patch)
    expect(system).toContain('You are the AI code reviewer that left a review comment.')
    expect(system).toContain('A developer replied.')
    expect(system).toContain('{"resolved":boolean,"response":string}')
  })

  it('includes all four required sections and question in user prompt', () => {
    const { user } = buildAdjudicationPrompts(root, discussion, fileContext, patch)
    expect(user).toContain('## Original finding')
    expect(user).toContain(root.body)
    expect(user).toContain('## Discussion')
    expect(user).toContain('- @alice: I added an early return above so this cannot be null.')
    expect(user).toContain('- @bob: Verified, checked the caller too.')
    expect(user).toContain('## Current file: src/handler.ts (around line 45)')
    expect(user).toContain(fileContext)
    expect(user).toContain('## Changes in this PR for src/handler.ts')
    expect(user).toContain(patch)
    expect(user).toContain('{"resolved":boolean,"response":string}')
  })
})

describe('fetchFileWindow', () => {
  it('returns whole file if total lines <= 300', async () => {
    const lines = Array.from({ length: 150 }, (_, i) => `const x${i} = ${i};`).join('\n')
    const contentB64 = Buffer.from(lines).toString('base64')
    const getContent = vi.fn().mockResolvedValue({ data: { content: contentB64 } })
    const octokit = { rest: { repos: { getContent } } } as unknown as Octokit

    const result = await fetchFileWindow(octokit, { owner: 'o', repo: 'r' }, 'src/app.ts', 'sha1', 75)
    expect(result).toBe(lines)
    expect(getContent).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      path: 'src/app.ts',
      ref: 'sha1',
    })
  })

  it('returns clamped lines [line-60, line+60] if total lines > 300', async () => {
    const fileLines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`)
    const contentB64 = Buffer.from(fileLines.join('\n')).toString('base64')
    const getContent = vi.fn().mockResolvedValue({ data: { content: contentB64 } })
    const octokit = { rest: { repos: { getContent } } } as unknown as Octokit

    const result = await fetchFileWindow(octokit, { owner: 'o', repo: 'r' }, 'src/app.ts', 'sha1', 200)
    const resultLines = result.split('\n')
    expect(resultLines[0]).toBe('line 140')
    expect(resultLines[resultLines.length - 1]).toBe('line 260')
    expect(resultLines).toHaveLength(121)
  })

  it('enforces hard cap of 400 lines with [file truncated] marker', async () => {
    const fileLines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`)
    const contentB64 = Buffer.from(fileLines.join('\n')).toString('base64')
    const getContent = vi.fn().mockResolvedValue({ data: { content: contentB64 } })
    const octokit = { rest: { repos: { getContent } } } as unknown as Octokit

    const result = await fetchFileWindow(octokit, { owner: 'o', repo: 'r' }, 'src/app.ts', 'sha1', 500, {
      window: 250,
    })
    expect(result).toContain('[file truncated]')
    const lines = result.split('\n')
    expect(lines[lines.length - 1]).toBe('[file truncated]')
    expect(lines.length - 1).toBe(400)
  })

  it('returns empty string on fetch failure', async () => {
    const getContent = vi.fn().mockRejectedValue(new Error('404 Not Found'))
    const octokit = { rest: { repos: { getContent } } } as unknown as Octokit

    const result = await fetchFileWindow(octokit, { owner: 'o', repo: 'r' }, 'missing.ts', 'sha1', 1)
    expect(result).toBe('')
  })
})

describe('fetchFilePatch', () => {
  it('returns patch when file is found in PR files', async () => {
    const files = [
      { filename: 'src/other.ts', patch: 'other patch' },
      { filename: 'src/target.ts', patch: 'target patch' },
    ]
    const paginate = vi.fn().mockResolvedValue(files)
    const octokit = { paginate } as unknown as Octokit

    const patch = await fetchFilePatch(octokit, { owner: 'o', repo: 'r' }, 12, 'src/target.ts')
    expect(patch).toBe('target patch')
  })

  it('truncates patch to 8000 chars with [patch truncated] suffix', async () => {
    const hugePatch = '+'.repeat(9000)
    const files = [{ filename: 'src/big.ts', patch: hugePatch }]
    const paginate = vi.fn().mockResolvedValue(files)
    const octokit = { paginate } as unknown as Octokit

    const patch = await fetchFilePatch(octokit, { owner: 'o', repo: 'r' }, 12, 'src/big.ts')
    expect(patch.length).toBeLessThan(9000)
    expect(patch).toContain('[patch truncated]')
    expect(patch.startsWith(hugePatch.slice(0, 8000))).toBe(true)
  })

  it('returns empty string when file is not found or has no patch', async () => {
    const files = [{ filename: 'src/other.ts' }]
    const paginate = vi.fn().mockResolvedValue(files)
    const octokit = { paginate } as unknown as Octokit

    const patch = await fetchFilePatch(octokit, { owner: 'o', repo: 'r' }, 12, 'src/none.ts')
    expect(patch).toBe('')
  })
})

describe('runReplyReview', () => {
  let mockOctokit: Octokit
  let mockProvider: ReviewProvider
  let createReply: ReturnType<typeof vi.fn>
  let graphql: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    createReply = vi.fn().mockResolvedValue({})
    graphql = vi.fn().mockResolvedValue({})
    mockProvider = {
      complete: vi.fn(),
      adjudicate: vi.fn().mockResolvedValue({
        resolved: true,
        response: 'Looks resolved now, thanks!',
      }),
    }
  })

  function makeDeps(commentId: number, commentAuthor: string): ReplyDeps {
    return {
      octokit: mockOctokit,
      repo: { owner: 'o', repo: 'r' },
      prNumber: 99,
      commentId,
      commentAuthor,
      headSha: 'head-sha-123',
      provider: mockProvider,
    }
  }

  it('skips when commentAuthor is the authenticated bot user (self-loop guard)', async () => {
    const getAuthenticated = vi.fn().mockResolvedValue({ data: { login: 'ai-bot[bot]' } })
    mockOctokit = {
      rest: { users: { getAuthenticated } },
    } as unknown as Octokit

    const result = await runReplyReview(makeDeps(100, 'ai-bot[bot]'))
    expect(result).toEqual({ outcome: 'skipped', reason: 'self' })
  })

  it('skips when thread is not found for commentId', async () => {
    const getAuthenticated = vi.fn().mockResolvedValue({ data: { login: 'ai-bot[bot]' } })
    const threadsFixture = {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [],
          },
        },
      },
    }
    graphql.mockResolvedValue(threadsFixture)
    mockOctokit = {
      graphql,
      rest: { users: { getAuthenticated } },
    } as unknown as Octokit

    const result = await runReplyReview(makeDeps(100, 'human-dev'))
    expect(result).toEqual({ outcome: 'skipped', reason: 'not-found' })
  })

  it('skips when thread is already resolved', async () => {
    const getAuthenticated = vi.fn().mockResolvedValue({ data: { login: 'ai-bot[bot]' } })
    const threadsFixture = {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: 'thread-1',
                isResolved: true,
                comments: {
                  nodes: [
                    { databaseId: 10, body: `${COMMENT_MARKER}\nFinding`, path: 'a.ts' },
                    { databaseId: 11, body: 'I fixed it', path: 'a.ts' },
                  ],
                },
              },
            ],
          },
        },
      },
    }
    graphql.mockResolvedValue(threadsFixture)
    mockOctokit = {
      graphql,
      rest: { users: { getAuthenticated } },
    } as unknown as Octokit

    const result = await runReplyReview(makeDeps(11, 'human-dev'))
    expect(result).toEqual({ outcome: 'skipped', reason: 'already-resolved' })
  })

  it('skips when the comment is the root comment', async () => {
    const getAuthenticated = vi.fn().mockResolvedValue({ data: { login: 'ai-bot[bot]' } })
    const threadsFixture = {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: 'thread-1',
                isResolved: false,
                comments: {
                  nodes: [{ databaseId: 10, body: `${COMMENT_MARKER}\nFinding`, path: 'a.ts' }],
                },
              },
            ],
          },
        },
      },
    }
    graphql.mockResolvedValue(threadsFixture)
    mockOctokit = {
      graphql,
      rest: { users: { getAuthenticated } },
    } as unknown as Octokit

    const result = await runReplyReview(makeDeps(10, 'human-dev'))
    expect(result).toEqual({ outcome: 'skipped', reason: 'root-comment' })
  })

  it('skips when root comment does not have COMMENT_MARKER', async () => {
    const getAuthenticated = vi.fn().mockResolvedValue({ data: { login: 'ai-bot[bot]' } })
    const threadsFixture = {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: 'thread-1',
                isResolved: false,
                comments: {
                  nodes: [
                    { databaseId: 10, body: 'Human root comment', path: 'a.ts' },
                    { databaseId: 11, body: 'Human reply', path: 'a.ts' },
                  ],
                },
              },
            ],
          },
        },
      },
    }
    graphql.mockResolvedValue(threadsFixture)
    mockOctokit = {
      graphql,
      rest: { users: { getAuthenticated } },
    } as unknown as Octokit

    const result = await runReplyReview(makeDeps(11, 'human-dev'))
    expect(result).toEqual({ outcome: 'skipped', reason: 'not-bot-thread' })
  })

  it('handles resolved adjudication: posts reply with marker and resolves thread', async () => {
    const getAuthenticated = vi.fn().mockResolvedValue({ data: { login: 'ai-bot[bot]' } })
    const threadsFixture = {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: 'thread-1',
                isResolved: false,
                comments: {
                  nodes: [
                    { databaseId: 10, body: `${COMMENT_MARKER}\nBug`, path: 'src/main.ts', line: 15 },
                    { databaseId: 11, author: { login: 'human-dev' }, body: 'Fixed in commit', path: 'src/main.ts' },
                  ],
                },
              },
            ],
          },
        },
      },
    }
    graphql.mockResolvedValue(threadsFixture)
    const getContent = vi.fn().mockResolvedValue({
      data: { content: Buffer.from('const x = 1\n').toString('base64') },
    })
    const paginate = vi.fn().mockResolvedValue([{ filename: 'src/main.ts', patch: '@@ -15 +15 @@' }])

    mockOctokit = {
      graphql,
      paginate,
      rest: {
        users: { getAuthenticated },
        repos: { getContent },
        pulls: { createReplyForReviewComment: createReply },
      },
    } as unknown as Octokit

    const result = await runReplyReview(makeDeps(11, 'human-dev'))
    expect(result).toEqual({ outcome: 'resolved' })
    expect(mockProvider.adjudicate).toHaveBeenCalled()
    expect(createReply).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      pull_number: 99,
      comment_id: 10,
      body: `${COMMENT_MARKER}\nLooks resolved now, thanks!`,
    })
    expect(graphql).toHaveBeenCalledWith(
      expect.stringContaining('resolveReviewThread'),
      { threadId: 'thread-1' },
    )
  })

  it('handles unresolved adjudication: posts reply and does not resolve thread', async () => {
    const getAuthenticated = vi.fn().mockResolvedValue({ data: { login: 'ai-bot[bot]' } })
    const threadsFixture = {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: 'thread-1',
                isResolved: false,
                comments: {
                  nodes: [
                    { databaseId: 10, body: `${COMMENT_MARKER}\nBug`, path: 'src/main.ts', line: 15 },
                    { databaseId: 11, author: { login: 'human-dev' }, body: 'Is this needed?', path: 'src/main.ts' },
                  ],
                },
              },
            ],
          },
        },
      },
    }
    graphql.mockResolvedValue(threadsFixture)
    const getContent = vi.fn().mockResolvedValue({
      data: { content: Buffer.from('const x = 1\n').toString('base64') },
    })
    const paginate = vi.fn().mockResolvedValue([{ filename: 'src/main.ts', patch: '@@ -15 +15 @@' }])
    vi.mocked(mockProvider.adjudicate).mockResolvedValueOnce({
      resolved: false,
      response: 'This is still required for security.',
    })

    mockOctokit = {
      graphql,
      paginate,
      rest: {
        users: { getAuthenticated },
        repos: { getContent },
        pulls: { createReplyForReviewComment: createReply },
      },
    } as unknown as Octokit

    const result = await runReplyReview(makeDeps(11, 'human-dev'))
    expect(result).toEqual({ outcome: 'unresolved' })
    expect(createReply).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      pull_number: 99,
      comment_id: 10,
      body: `${COMMENT_MARKER}\nThis is still required for security.`,
    })
    expect(graphql).not.toHaveBeenCalledWith(
      expect.stringContaining('resolveReviewThread'),
      expect.anything(),
    )
  })

  it('warns and continues if posting reply or resolving thread fails', async () => {
    const getAuthenticated = vi.fn().mockResolvedValue({ data: { login: 'ai-bot[bot]' } })
    const threadsFixture = {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: 'thread-1',
                isResolved: false,
                comments: {
                  nodes: [
                    { databaseId: 10, body: `${COMMENT_MARKER}\nBug`, path: 'src/main.ts', line: 15 },
                    { databaseId: 11, author: { login: 'human-dev' }, body: 'Fixed', path: 'src/main.ts' },
                  ],
                },
              },
            ],
          },
        },
      },
    }
    graphql.mockResolvedValue(threadsFixture)
    const getContent = vi.fn().mockResolvedValue({
      data: { content: Buffer.from('const x = 1\n').toString('base64') },
    })
    const paginate = vi.fn().mockResolvedValue([{ filename: 'src/main.ts', patch: '@@ -15 +15 @@' }])
    createReply.mockRejectedValueOnce(new Error('GitHub API error'))

    mockOctokit = {
      graphql,
      paginate,
      rest: {
        users: { getAuthenticated },
        repos: { getContent },
        pulls: { createReplyForReviewComment: createReply },
      },
    } as unknown as Octokit

    const result = await runReplyReview(makeDeps(11, 'human-dev'))
    expect(result).toEqual({ outcome: 'resolved' })
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('GitHub API error'))
  })
})
