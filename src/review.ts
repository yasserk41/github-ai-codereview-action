import type { Octokit } from '@octokit/core' with { 'resolution-mode': 'import' }
import { resolveConfig, type RawInputs, type RepoConfig } from './config'
import {
  buildDiffContext,
  fetchPrFiles,
} from './diff'
import {
  buildSummaryBody,
  cleanupPreviousComments,
  filterFindings,
  postReview,
  resolveVerdict,
} from './comment'
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

  await cleanupPreviousComments(deps.octokit, deps.repo, deps.prNumber)
  await postReview(deps.octokit, deps.repo, deps.prNumber, body, event, inline)

  return {
    findingsCount: inline.length + summaryOnly.length,
    inlineCount: inline.length,
    summaryOnlyCount: summaryOnly.length,
    verdict,
  }
}
