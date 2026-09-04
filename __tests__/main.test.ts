import { describe, it, expect } from 'vitest'
import { describeError } from '../src/main'
import { ConfigError } from '../src/providers/types'
import { ProviderConfigError } from '../src/providers/registry'

describe('describeError', () => {
  it('returns the message directly for known error types', () => {
    expect(describeError(new ConfigError('bad config'))).toBe('bad config')
    expect(describeError(new ProviderConfigError('bad provider'))).toBe('bad provider')
  })

  it('returns the raw response for provider JSON failures', () => {
    const err = new Error('nope')
    err.name = 'ProviderError'
    expect(describeError(err)).toBe('nope')
  })

  it('labels unexpected errors', () => {
    expect(describeError(new Error('boom'))).toContain('Unexpected error')
    expect(describeError('str')).toContain('Unexpected error')
  })
})
