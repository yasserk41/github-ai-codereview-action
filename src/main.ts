import * as core from '@actions/core'
import { context, getOctokit } from '@actions/github'
import { loadRepoConfig, readRawInputs } from './config'
import { runReview } from './review'
import { ProviderConfigError } from './providers/registry'
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

async function run(): Promise<void> {
  const pr = context.payload.pull_request
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
