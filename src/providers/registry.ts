import type { RawInputs } from '../config'
import { AnthropicProvider } from './anthropic'
import { OpenAICompatibleProvider } from './openai-compatible'
import { OpenAIProvider } from './openai'
import type { ReviewProvider } from './types'

export interface ProviderPreset {
  adapter: 'openai' | 'anthropic' | 'openai-compatible'
  defaultModel: string
  baseUrl?: string
  apiKeyEnv: string
  contextWindowTokens: number
}

export const PRESETS: Record<string, ProviderPreset> = {
  openai: {
    adapter: 'openai',
    defaultModel: 'gpt-4.1',
    apiKeyEnv: 'OPENAI_API_KEY',
    contextWindowTokens: 1000000,
  },
  anthropic: {
    adapter: 'anthropic',
    defaultModel: 'claude-sonnet-4-5',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    contextWindowTokens: 200000,
  },
  zai: {
    adapter: 'openai-compatible',
    defaultModel: 'glm-4.6',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    apiKeyEnv: 'ZAI_API_KEY',
    contextWindowTokens: 200000,
  },
  kimi: {
    adapter: 'openai-compatible',
    defaultModel: 'kimi-k2',
    baseUrl: 'https://api.moonshot.ai/v1',
    apiKeyEnv: 'KIMI_API_KEY',
    contextWindowTokens: 131072,
  },
  custom: {
    adapter: 'openai-compatible',
    defaultModel: '',
    apiKeyEnv: 'CUSTOM_API_KEY',
    contextWindowTokens: 128000,
  },
}

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderConfigError'
  }
}

export function getPreset(provider: string): ProviderPreset {
  const preset = PRESETS[provider]
  if (!preset) {
    throw new ProviderConfigError(
      `Unknown provider "${provider}". Supported: ${Object.keys(PRESETS).join(', ')}.`,
    )
  }
  return preset
}

export function createProvider(raw: RawInputs): ReviewProvider {
  const preset = getPreset(raw.provider)
  const model = raw.model || preset.defaultModel
  const baseUrl = raw.baseUrl || preset.baseUrl
  if (preset.adapter === 'openai-compatible') {
    if (!model) {
      throw new ProviderConfigError('The "model" input is required when provider is "custom".')
    }
    if (!baseUrl) {
      throw new ProviderConfigError('The "base-url" input is required when provider is "custom".')
    }
  }
  const apiKey = process.env[preset.apiKeyEnv]
  if (!apiKey) {
    throw new ProviderConfigError(
      `Missing API key for provider "${raw.provider}": set the ${preset.apiKeyEnv} environment variable.`,
    )
  }
  if (preset.adapter === 'anthropic') return new AnthropicProvider(model, apiKey)
  if (preset.adapter === 'openai') return new OpenAIProvider(model, apiKey)
  return new OpenAICompatibleProvider(model, apiKey, baseUrl as string)
}
