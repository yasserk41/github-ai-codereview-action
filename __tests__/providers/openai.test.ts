import { describe, it, expect, vi } from 'vitest'
import type OpenAI from 'openai'
import { OpenAIProvider } from '../../src/providers/openai'
import type { Finding } from '../../src/providers/types'

const finding: Finding = {
  file: 'src/app.ts',
  line: 3,
  severity: 'critical',
  title: 'Remote code execution',
  body: 'eval() on user input.',
}

function fakeClient(contents: string[]) {
  const create = vi.fn()
  for (const content of contents) {
    create.mockResolvedValueOnce({ choices: [{ message: { content } }] })
  }
  return {
    chat: { completions: { create } },
    create,
    calls: () => create.mock.calls as unknown as [Record<string, unknown>][],
  }
}

function providerWith(contents: string[]): { provider: OpenAIProvider; create: ReturnType<typeof fakeClient>['create']; calls: () => unknown[][] } {
  const client = fakeClient(contents)
  return {
    provider: new OpenAIProvider('gpt-4.1', 'key', undefined, client as unknown as OpenAI),
    create: client.create,
    calls: client.calls,
  }
}

describe('OpenAIProvider.complete', () => {
  it('returns parsed findings and requests json_schema output', async () => {
    const { provider, calls } = providerWith([JSON.stringify({ findings: [finding] })])
    const result = await provider.complete('system', 'user')
    expect(result).toEqual([finding])
    const body = calls()[0][0] as Record<string, unknown>
    expect(body['model']).toBe('gpt-4.1')
    expect(body['response_format']).toEqual({
      type: 'json_schema',
      json_schema: { name: 'findings', strict: true, schema: expect.any(Object) },
    })
  })

  it('retries once with the repair instruction on invalid JSON', async () => {
    const { provider, calls } = providerWith(['nope', JSON.stringify({ findings: [] })])
    const result = await provider.complete('system', 'user')
    expect(result).toEqual([])
    expect(calls()).toHaveLength(2)
    const retryBody = calls()[1][0] as { messages: { content: string }[] }
    expect(retryBody.messages[1].content).toContain('IMPORTANT')
  })

  it('throws ProviderError when the retry also fails', async () => {
    const { provider } = providerWith(['nope', 'still nope'])
    await expect(provider.complete('system', 'user')).rejects.toThrow(/not valid JSON/)
  })
})
