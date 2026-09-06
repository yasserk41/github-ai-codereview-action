import * as core from '@actions/core'
import { context, getOctokit } from '@actions/github'
import { loadRepoConfig, readRawInputs } from './config'
import { runReview } from './review'
import { runReplyReview } from './reply'
import { createProvider, ProviderConfigError } from './providers/registry'
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

export function isReplyAdjudicationEvent(
  eventName: string,
  payload: { action?: string; comment?: { id: number; in_reply_to_id?: number } },
): boolean {
  return eventName === 'pull_request_review_comment' && payload.action === 'created' && !!payload.comment
}

export async function run(): Promise<void> {
  const payload = context.payload as {
    comment?: { id: number; user?: { login: string }; body?: string; in_reply_to_id?: number }
    pull_request?: {
      number: number
      title?: string
      body?: string
      head: { sha: string }
    }
  }

  if (isReplyAdjudicationEvent(context.eventName, context.payload as { action?: string })) {
    if (!payload.comment) return
    const raw = readRawInputs()
    if (!raw.adjudicateReplies) {
      core.info('Reply adjudication disabled')
      return
    }
    if (!payload.comment.in_reply_to_id) {
      core.info('Not a reply; nothing to do.')
      return
    }
    if (!payload.pull_request) return
    const octokit = getOctokit(raw.githubToken)
    const provider = createProvider(raw)
    const result = await runReplyReview({
      octokit,
      repo: context.repo,
      prNumber: payload.pull_request.number,
      commentId: payload.comment.id,
      commentAuthor: payload.comment.user?.login ?? '',
      commentBody: payload.comment.body ?? '',
      headSha: payload.pull_request.head.sha,
      provider,
    })
    core.setOutput('adjudication', result.outcome)
    core.info(
      `Reply adjudication: ${result.outcome}${result.reason ? ' (' + result.reason + ')' : ''}`,
    )
    return
  }

  const pr = payload.pull_request
  if (!pr) {
    core.info('Not a pull request event; nothing to do.')
    return
  }
  const raw = readRawInputs()
  const octokit = getOctokit(raw.githubToken)
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
  core.setOutput('verdict', result.verdict)
  core.setOutput('resolved-threads', String(result.resolvedThreads))
}

run().catch((err) => {
  core.setFailed(describeError(err))
})
