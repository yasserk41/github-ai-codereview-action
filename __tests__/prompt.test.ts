import { describe, it, expect } from 'vitest'
import { buildSystemPrompt, buildUserPrompt } from '../src/prompt'
import type { DiffContext, ReviewConfig } from '../src/providers/types'

const baseConfig: ReviewConfig = {
  provider: 'openai',
  model: 'gpt-4.1',
  contextWindowTokens: 1000000,
  maxComments: 20,
  reviewStyle: 'high-signal',
  severityThreshold: 'suggestion',
  verdict: 'comment',
  requestChangesOn: 'critical',
}

const sampleDiff: DiffContext = {
  files: [
    { path: 'src/app.ts', patch: '@@ -1,1 +1,2 @@\n+const b = 3', commentableLines: [1, 2] },
  ],
  truncated: false,
  skipped: [],
  estimatedTokens: 10,
}

describe('buildSystemPrompt', () => {
  it('high-signal style forbids style nits', () => {
    const prompt = buildSystemPrompt(baseConfig)
    expect(prompt).toContain('bugs, security vulnerabilities, logic errors, and performance problems')
    expect(prompt).not.toContain('naming')
  })

  it('thorough style includes naming and documentation', () => {
    const prompt = buildSystemPrompt({ ...baseConfig, reviewStyle: 'thorough' })
    expect(prompt).toContain('naming')
    expect(prompt).toContain('documentation')
  })

  it('appends custom instructions verbatim', () => {
    const prompt = buildSystemPrompt({ ...baseConfig, customInstructions: 'We use Vitest.' })
    expect(prompt).toContain('We use Vitest.')
  })

  it('states the JSON contract and severity levels', () => {
    const prompt = buildSystemPrompt(baseConfig)
    expect(prompt).toContain('"findings"')
    expect(prompt).toContain('critical')
    expect(prompt).toContain('suggestion')
    expect(prompt).toContain('empty findings array')
  })
})

describe('buildUserPrompt', () => {
  it('includes PR title, body, file paths, and patches', () => {
    const prompt = buildUserPrompt(sampleDiff, { title: 'Fix bug', body: 'Fixes #1' })
    expect(prompt).toContain('Fix bug')
    expect(prompt).toContain('Fixes #1')
    expect(prompt).toContain('src/app.ts')
    expect(prompt).toContain('const b = 3')
  })

  it('handles a missing PR body', () => {
    const prompt = buildUserPrompt(sampleDiff, { title: 'T', body: '' })
    expect(prompt).toContain('T')
  })
})
