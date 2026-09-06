import * as core from '@actions/core'
import type { Octokit } from '@octokit/core' with { 'resolution-mode': 'import' }
import { resolveConfig, type RawInputs, type RepoConfig } from './config'
import {
  buildDiffContext,
  fetchPrFiles,
} from './diff'
import {
  buildSummaryBody,
  filterFindings,
  postReview,
  resolveVerdict,
} from './comment'
import {
  getBotThreads,
  planReconciliation,
  replyToComment,
  resolveThread,
  RESOLVE_REPLY_BODY,
  type BotThread,
} from './threads'
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
  verdict: 'approved' | 'changes-requested' | 'commented'
  resolvedThreads: number
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
  let event: 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE' = 'COMMENT'
  let verdict: 'approved' | 'changes-requested' | 'commented' = 'commented'

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
    event = resolveVerdict(filtered, config)
    if (event === 'APPROVE') {
      verdict = 'approved'
    } else if (event === 'REQUEST_CHANGES') {
      verdict = 'changes-requested'
    } else {
      verdict = 'commented'
    }
  }

  const threads = await getBotThreads(deps.octokit, deps.repo, deps.prNumber)
  let toResolve: BotThread[] = []

  if (diff.files.length === 0) {
    toResolve = threads
  } else {
    const planned = planReconciliation(threads, inline)
    toResolve = planned.toResolve
    const suppressSet = new Set(planned.suppress)
    inline = inline.filter((f) => !suppressSet.has(`${f.file}:${f.line}`))
  }

  let actuallyResolved = 0
  for (const thread of toResolve) {
    try {
      await replyToComment(deps.octokit, deps.repo, deps.prNumber, thread.firstCommentId, RESOLVE_REPLY_BODY)
      await resolveThread(deps.octokit, thread.threadId)
      actuallyResolved++
    } catch (err) {
      core.warning(`Failed to auto-resolve review thread (${thread.path}:${thread.line}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  try {
    await postReview(deps.octokit, deps.repo, deps.prNumber, body, event, inline)
  } catch (err) {
    if (
      event === 'APPROVE' &&
      err instanceof Error &&
      err.message.includes('not permitted to approve')
    ) {
      core.warning(
        'GitHub forbids token-based PR approvals; submitting the review as COMMENT instead. Use a PAT or GitHub App token via github-token to submit real approvals.',
      )
      await postReview(deps.octokit, deps.repo, deps.prNumber, body, 'COMMENT', inline)
    } else {
      throw err
    }
  }

  return {
    findingsCount: inline.length + summaryOnly.length,
    inlineCount: inline.length,
    summaryOnlyCount: summaryOnly.length,
    verdict,
    resolvedThreads: actuallyResolved,
  }
}
