import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRepoConfig, readRawInputs, resolveConfig, ConfigError } from '../src/config'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ai-review-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('loadRepoConfig', () => {
  it('returns defaults when the file is missing', async () => {
    const config = await loadRepoConfig(join(dir, '.ai-review.yml'))
    expect(config).toEqual({
      paths: ['**/*'],
      pathsIgnore: [],
      maxComments: 20,
      reviewStyle: 'high-signal',
      severityThreshold: 'suggestion',
    })
  })

  it('parses a full config file', async () => {
    const path = join(dir, '.ai-review.yml')
    await writeFile(
      path,
      [
        'paths: ["src/**"]',
        'paths-ignore: ["**/*.test.ts"]',
        'max-comments: 5',
        'review-style: thorough',
        'severity-threshold: warning',
        'custom-instructions: |',
        '  We use Vitest, not Jest.',
      ].join('\n'),
    )
    const config = await loadRepoConfig(path)
    expect(config.paths).toEqual(['src/**'])
    expect(config.pathsIgnore).toEqual(['**/*.test.ts'])
    expect(config.maxComments).toBe(5)
    expect(config.reviewStyle).toBe('thorough')
    expect(config.severityThreshold).toBe('warning')
    expect(config.customInstructions).toBe('We use Vitest, not Jest.\n')
  })

  it('fails naming the offending key on unknown keys', async () => {
    const path = join(dir, '.ai-review.yml')
    await writeFile(path, 'mx-comments: 5')
    await expect(loadRepoConfig(path)).rejects.toThrow(/mx-comments/)
  })

  it('fails on invalid values', async () => {
    const path = join(dir, '.ai-review.yml')
    await writeFile(path, 'max-comments: -3')
    await expect(loadRepoConfig(path)).rejects.toThrow(ConfigError)
  })

  it('fails with a parse error on malformed YAML', async () => {
    const path = join(dir, '.ai-review.yml')
    await writeFile(path, 'paths: ["unterminated')
    await expect(loadRepoConfig(path)).rejects.toThrow(/parse/i)
  })
})

describe('readRawInputs', () => {
  it('applies fallback defaults when inputs are empty', () => {
    const raw = readRawInputs(() => '')
    expect(raw.provider).toBe('openai')
    expect(raw.configPath).toBe('.ai-review.yml')
    expect(raw.contextWindow).toBe('')
    expect(raw.githubToken).toBe('')
  })

  it('reads provided inputs', () => {
    const raw = readRawInputs(
      (name) =>
        ({ provider: 'kimi', model: 'kimi-k2', 'github-token': 't' } as Record<string, string>)[
          name
        ] ?? '',
    )
    expect(raw.provider).toBe('kimi')
    expect(raw.model).toBe('kimi-k2')
    expect(raw.githubToken).toBe('t')
  })
})

describe('resolveConfig', () => {
  const raw = readRawInputs(() => '')
  const repo = { paths: ['**/*'], pathsIgnore: [], maxComments: 20, reviewStyle: 'high-signal', severityThreshold: 'suggestion' } as const

  it('uses preset defaults when inputs are empty', () => {
    const config = resolveConfig(raw, repo, { defaultModel: 'glm-4.6', contextWindowTokens: 200000 })
    expect(config.model).toBe('glm-4.6')
    expect(config.contextWindowTokens).toBe(200000)
  })

  it('input model overrides preset default', () => {
    const config = resolveConfig(
      { ...raw, model: 'gpt-4o' },
      repo,
      { defaultModel: 'gpt-4.1', contextWindowTokens: 1000000 },
    )
    expect(config.model).toBe('gpt-4o')
  })

  it('input context-window overrides preset default', () => {
    const config = resolveConfig(
      { ...raw, contextWindow: '64000' },
      repo,
      { defaultModel: 'm', contextWindowTokens: 200000 },
    )
    expect(config.contextWindowTokens).toBe(64000)
  })

  it('propagates repo config', () => {
    const config = resolveConfig(raw, { ...repo, maxComments: 3 }, { defaultModel: 'm', contextWindowTokens: 1000 })
    expect(config.maxComments).toBe(3)
    expect(config.provider).toBe('openai')
  })
})
