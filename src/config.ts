import * as core from '@actions/core'
import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { ConfigError, SEVERITIES, type ReviewConfig, type Severity } from './providers/types'

export { ConfigError }

const RepoConfigSchema = z
  .object({
    paths: z.array(z.string()).default(['**/*']),
    'paths-ignore': z.array(z.string()).default([]),
    'max-comments': z.number().int().min(0).default(20),
    'review-style': z.enum(['high-signal', 'thorough']).default('high-signal'),
    'severity-threshold': z.enum(['critical', 'warning', 'suggestion']).default('suggestion'),
    'custom-instructions': z.string().optional(),
  })
  .strict()

export interface RepoConfig {
  paths: readonly string[]
  pathsIgnore: readonly string[]
  maxComments: number
  reviewStyle: 'high-signal' | 'thorough'
  severityThreshold: Severity
  customInstructions?: string
}

export interface RawInputs {
  provider: string
  model: string
  baseUrl: string
  contextWindow: string
  githubToken: string
  configPath: string
  verdict: string
  requestChangesOn: string
  adjudicateReplies: boolean
}

export async function loadRepoConfig(path: string): Promise<RepoConfig> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      text = ''
    } else {
      throw new ConfigError(`Could not read ${path}: ${String(err)}`)
    }
  }
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (err) {
    throw new ConfigError(`Could not parse ${path} as YAML: ${String(err)}`)
  }
  const parsed = RepoConfigSchema.safeParse(raw ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const key = issue.path.join('.') || 'document'
    throw new ConfigError(`Invalid ${path}: "${key}" ${issue.message}`)
  }
  const c = parsed.data
  const config: RepoConfig = {
    paths: c.paths,
    pathsIgnore: c['paths-ignore'],
    maxComments: c['max-comments'],
    reviewStyle: c['review-style'],
    severityThreshold: c['severity-threshold'],
  }
  if (c['custom-instructions'] !== undefined) {
    config.customInstructions = c['custom-instructions']
  }
  return config
}

export function readRawInputs(
  getInput: (name: string) => string = core.getInput,
): RawInputs {
  return {
    provider: getInput('provider') || 'openai',
    model: getInput('model') || '',
    baseUrl: getInput('base-url') || '',
    contextWindow: getInput('context-window') || '',
    githubToken: getInput('github-token'),
    configPath: getInput('config-path') || '.ai-review.yml',
    verdict: getInput('verdict') || 'comment',
    requestChangesOn: getInput('request-changes-on') || 'critical',
    adjudicateReplies: getInput('adjudicate-replies') !== 'false',
  }
}

export function resolveConfig(
  raw: RawInputs,
  repo: RepoConfig,
  preset: { defaultModel: string; contextWindowTokens: number },
): ReviewConfig {
  const verdict = raw.verdict === 'auto' ? 'auto' : 'comment'
  const requestChangesOn: Severity = (SEVERITIES as readonly string[]).includes(
    raw.requestChangesOn,
  )
    ? (raw.requestChangesOn as Severity)
    : 'critical'
  return {
    provider: raw.provider,
    model: raw.model || preset.defaultModel,
    contextWindowTokens: raw.contextWindow
      ? Number(raw.contextWindow)
      : preset.contextWindowTokens,
    maxComments: repo.maxComments,
    reviewStyle: repo.reviewStyle,
    severityThreshold: repo.severityThreshold,
    customInstructions: repo.customInstructions,
    verdict,
    requestChangesOn,
  }
}
