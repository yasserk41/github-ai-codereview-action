import * as core from '@actions/core'
import type { Octokit } from '@octokit/core' with { 'resolution-mode': 'import' }
import { fetchPrFiles } from './diff'
import {
  getAllReviewThreads,
  replyToComment,
  resolveThread,
  type ThreadComment,
} from './threads'
import { COMMENT_MARKER, type ReviewProvider } from './providers/types'

export interface ReplyDeps {
  octokit: Octokit
  repo: { owner: string; repo: string }
  prNumber: number
  commentId: number
  commentAuthor: string
  commentBody: string
  headSha: string
  provider: ReviewProvider
}

export type ReplyResult = { outcome: 'resolved' | 'unresolved' | 'skipped'; reason?: string }

interface OctokitWithContent {
  rest?: {
    repos?: {
      getContent?: (params: {
        owner: string
        repo: string
        path: string
        ref: string
      }) => Promise<{ data?: unknown }>
    }
  }
}

export function buildAdjudicationPrompts(
  root: ThreadComment,
  discussion: ThreadComment[],
  fileContext: string,
  patch: string,
): { system: string; user: string } {
  const lineNum = root.line ?? root.originalLine ?? 1
  const system = [
    'You are the AI code reviewer that left a review comment. A developer replied. Decide whether the discussion and the current code resolve the finding.',
    'Rules:',
    '- resolved=true only if the reply justifies non-fix (does not apply, intentional with valid justification) OR the current file/diff shows the issue fixed.',
    '- response is 1-3 sentences of markdown addressing the developer directly.',
    '- respond ONLY with JSON {"resolved":boolean,"response":string}',
  ].join('\n')

  const discussionLines = discussion.map((c) => `- @${c.author}: ${c.body}`).join('\n')

  const user = [
    '## Original finding',
    '',
    root.body,
    '',
    '## Discussion',
    '',
    discussionLines,
    '',
    `## Current file: ${root.path} (around line ${lineNum})`,
    '',
    '```',
    fileContext,
    '```',
    '',
    `## Changes in this PR for ${root.path}`,
    '',
    '```diff',
    patch,
    '```',
    '',
    'Does the discussion or the current code resolve the finding? Respond ONLY with JSON {"resolved":boolean,"response":string}.',
  ].join('\n')

  return { system, user }
}

export async function fetchFileWindow(
  octokit: Octokit,
  repo: { owner: string; repo: string },
  path: string,
  ref: string,
  line: number,
  opts?: { window?: number; maxLines?: number },
): Promise<string> {
  try {
    const client = octokit as unknown as OctokitWithContent
    const res = await client.rest?.repos?.getContent?.({
      owner: repo.owner,
      repo: repo.repo,
      path,
      ref,
    })
    const data = res?.data as { content?: string; encoding?: string } | undefined
    if (!data || typeof data.content !== 'string') {
      return ''
    }
    const decoded = Buffer.from(data.content, 'base64').toString('utf8')
    const lines = decoded.split('\n')
    const window = opts?.window ?? 60
    const maxLines = opts?.maxLines ?? 400
    let selectedLines: string[]
    if (lines.length <= 300) {
      selectedLines = lines
    } else {
      const start = Math.max(1, line - window)
      const end = Math.min(lines.length, line + window)
      selectedLines = lines.slice(start - 1, end)
    }
    if (selectedLines.length > maxLines) {
      return selectedLines.slice(0, maxLines).join('\n') + '\n[file truncated]'
    }
    return selectedLines.join('\n')
  } catch {
    return ''
  }
}

export async function fetchFilePatch(
  octokit: Octokit,
  repo: { owner: string; repo: string },
  prNumber: number,
  path: string,
): Promise<string> {
  const files = await fetchPrFiles(octokit, repo, prNumber)
  const file = files.find((f) => f.filename === path)
  if (!file || typeof file.patch !== 'string') {
    return ''
  }
  if (file.patch.length > 8000) {
    return file.patch.slice(0, 8000) + '\n[patch truncated]'
  }
  return file.patch
}

export async function runReplyReview(deps: ReplyDeps): Promise<ReplyResult> {
  if (deps.commentBody.includes(COMMENT_MARKER)) {
    return { outcome: 'skipped', reason: 'self' }
  }

  const threads = await getAllReviewThreads(deps.octokit, deps.repo, deps.prNumber)
  const thread = threads.find((t) => t.comments.some((c) => c.id === deps.commentId))
  if (!thread) {
    return { outcome: 'skipped', reason: 'not-found' }
  }

  if (thread.isResolved) {
    return { outcome: 'skipped', reason: 'already-resolved' }
  }

  const root = thread.comments[0]
  if (!root || root.id === deps.commentId) {
    return { outcome: 'skipped', reason: 'root-comment' }
  }
  if (!root.body.includes(COMMENT_MARKER)) {
    return { outcome: 'skipped', reason: 'not-bot-thread' }
  }
  if (deps.commentAuthor === root.author) {
    return { outcome: 'skipped', reason: 'self' }
  }

  const patch = await fetchFilePatch(deps.octokit, deps.repo, deps.prNumber, root.path)
  const window = await fetchFileWindow(
    deps.octokit,
    deps.repo,
    root.path,
    deps.headSha,
    root.line ?? root.originalLine ?? 1,
  )

  const { system, user } = buildAdjudicationPrompts(
    root,
    thread.comments.slice(1),
    window,
    patch,
  )
  const result = await deps.provider.adjudicate(system, user)

  try {
    await replyToComment(
      deps.octokit,
      deps.repo,
      deps.prNumber,
      root.id,
      `${COMMENT_MARKER}\n${result.response}`,
    )
    if (result.resolved) {
      await resolveThread(deps.octokit, thread.threadId)
    }
  } catch (err) {
    core.warning(
      `Failed to reply to comment or resolve thread: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  return { outcome: result.resolved ? 'resolved' : 'unresolved' }
}
