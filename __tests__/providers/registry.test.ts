import { describe, it, expect, vi } from 'vitest'
import type OpenAI from 'openai'
import {
  PRESETS,
  createProvider,
  getPreset,
  ProviderConfigError,
} from '../../src/providers/registry'
import { OpenAICompatibleProvider } from '../../src/providers/openai-compatible'
import { AnthropicProvider } from '../../src/providers/anthropic'
import type { RawInputs } from '../../src/config'

function raw(overrides: Partial<RawInputs> = {}): RawInputs {
  return {
    provider: 'openai',
    model: '',
    baseUrl: '',
    contextWindow: '128000',
    githubToken: 't',
    configPath: '.ai-review.yml',
    verdict: 'comment',
    requestChangesOn: 'critical',
    ...overrides,
  }
}

describe('PRESETS', () => {
  it('has the five supported providers with defaults', () => {
    expect(Object.keys(PRESETS).sort()).toEqual(['anthropic', 'custom', 'kimi', 'openai', 'zai'])
    expect(PRESETS['zai'].baseUrl).toBe('https://api.z.ai/api/paas/v4')
    expect(PRESETS['kimi'].baseUrl).toBe('https://api.moonshot.ai/v1')
    expect(PRESETS['openai'].defaultModel).toBe('gpt-4.1')
    expect(PRESETS['anthropic'].defaultModel).toBe('claude-sonnet-4-5')
    expect(PRESETS['zai'].apiKeyEnv).toBe('ZAI_API_KEY')
    expect(PRESETS['kimi'].apiKeyEnv).toBe('KIMI_API_KEY')
  })
})

describe('getPreset', () => {
  it('throws listing supported providers on unknown input', () => {
    expect(() => getPreset('grok')).toThrow(ProviderConfigError)
    expect(() => getPreset('grok')).toThrow(/openai, anthropic, zai, kimi, custom/)
  })
})

describe('createProvider', () => {
  it('builds an OpenAI-compatible provider for zai using the preset base URL', () => {
    process.env.ZAI_API_KEY = 'k'
    const provider = createProvider(raw({ provider: 'zai' }))
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider)
    process.env.ZAI_API_KEY = ''
  })

  it('builds an Anthropic provider for anthropic', () => {
    process.env.ANTHROPIC_API_KEY = 'k'
    expect(createProvider(raw({ provider: 'anthropic' }))).toBeInstanceOf(AnthropicProvider)
    process.env.ANTHROPIC_API_KEY = ''
  })

  it('throws naming the missing env var', () => {
    delete process.env.OPENAI_API_KEY
    expect(() => createProvider(raw())).toThrow(/OPENAI_API_KEY/)
  })

  it('requires model and base-url for custom', () => {
    process.env.CUSTOM_API_KEY = 'k'
    expect(() => createProvider(raw({ provider: 'custom' }))).toThrow(/model/)
    expect(() => createProvider(raw({ provider: 'custom', model: 'llama3' }))).toThrow(/base-url/)
    expect(
      createProvider(raw({ provider: 'custom', model: 'llama3', baseUrl: 'http://x/v1' })),
    ).toBeInstanceOf(OpenAICompatibleProvider)
    delete process.env.CUSTOM_API_KEY
  })
})

describe('OpenAICompatibleProvider', () => {
  it('requests json_object instead of json_schema', async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ choices: [{ message: { content: '{"findings":[]}' } }] })
    const provider = new OpenAICompatibleProvider(
      'glm-4.6',
      'k',
      'https://api.z.ai/api/paas/v4',
      { chat: { completions: { create } } } as unknown as OpenAI,
    )
    const result = await provider.complete('s', 'u')
    expect(result).toEqual([])
    const body = create.mock.calls[0][0] as Record<string, unknown>
    expect(body['response_format']).toEqual({ type: 'json_object' })
    expect(body['model']).toBe('glm-4.6')
  })
})
