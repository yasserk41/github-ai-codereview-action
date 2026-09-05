import type { Octokit } from '@octokit/core' with { 'resolution-mode': 'import' }
import { COMMENT_MARKER, type Finding } from './providers/types'

export interface BotThread {
  threadId: string
  isResolved: boolean
  path: string
  line: number
  firstCommentId: number
}

export const RESOLVE_REPLY_BODY = `${COMMENT_MARKER}\nFix verified — this issue was not flagged in the latest review. Auto-resolving.`

interface GraphQLCommentNode {
  databaseId: number
  body?: string
  path: string
  line?: number | null
  originalLine?: number | null
}

interface GraphQLThreadNode {
  id: string
  isResolved: boolean
  comments: {
    nodes: GraphQLCommentNode[]
  }
}

interface GraphQLQueryResult {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        nodes?: GraphQLThreadNode[]
      }
    }
  }
}

interface OctokitThreadsClient {
  graphql: (query: string, params?: Record<string, unknown>) => Promise<unknown>
  rest: {
    pulls: {
      createReplyForReviewComment: (params: {
        owner: string
        repo: string
        comment_id: number
        body: string
      }) => Promise<unknown>
    }
  }
}

export async function getBotThreads(
  octokit: Octokit,
  repo: { owner: string; repo: string },
  prNumber: number,
): Promise<BotThread[]> {
  const client = octokit as unknown as OctokitThreadsClient
  const query = `
    query($owner: String!, $repo: String!, $prNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              comments(first: 50) {
                nodes {
                  databaseId
                  body
                  path
                  line
                  originalLine
                }
              }
            }
          }
        }
      }
    }
  `
  const data = (await client.graphql(query, {
    owner: repo.owner,
    repo: repo.repo,
    prNumber,
  })) as GraphQLQueryResult

  const nodes = data?.repository?.pullRequest?.reviewThreads?.nodes ?? []
  const threads: BotThread[] = []

  for (const node of nodes) {
    if (node.isResolved) {
      continue
    }
    const comments = node.comments?.nodes ?? []
    if (comments.length === 0) {
      continue
    }
    const hasMarker = comments.some((c) => c.body?.includes(COMMENT_MARKER))
    if (!hasMarker) {
      continue
    }
    const firstComment = comments[0]
    const line = firstComment.line ?? firstComment.originalLine ?? 0
    threads.push({
      threadId: node.id,
      isResolved: node.isResolved,
      path: firstComment.path,
      line,
      firstCommentId: firstComment.databaseId,
    })
  }

  return threads
}

export async function resolveThread(
  octokit: Octokit,
  threadId: string,
): Promise<void> {
  const client = octokit as unknown as OctokitThreadsClient
  const mutation = `
    mutation resolveReviewThread($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) {
        thread {
          id
          isResolved
        }
      }
    }
  `
  await client.graphql(mutation, { threadId })
}

export async function replyToComment(
  octokit: Octokit,
  repo: { owner: string; repo: string },
  commentId: number,
  body: string,
): Promise<void> {
  const client = octokit as unknown as OctokitThreadsClient
  await client.rest.pulls.createReplyForReviewComment({
    owner: repo.owner,
    repo: repo.repo,
    comment_id: commentId,
    body,
  })
}

export function planReconciliation(
  threads: BotThread[],
  newInline: Finding[],
): { toResolve: BotThread[]; suppress: string[] } {
  const toResolve: BotThread[] = []
  const suppressSet = new Set<string>()

  for (const thread of threads) {
    const matched = newInline.some(
      (f) => f.file === thread.path && f.line === thread.line,
    )
    if (matched) {
      suppressSet.add(`${thread.path}:${thread.line}`)
    } else {
      toResolve.push(thread)
    }
  }

  return {
    toResolve,
    suppress: Array.from(suppressSet),
  }
}
