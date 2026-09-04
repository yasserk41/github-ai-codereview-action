import { describe, it, expect, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { AnthropicProvider } from '../../src/providers/anthropic'
import type { Finding } from '../../src/providers/types'

const finding: Finding = {
  file: 'src/app.ts',
  line: 3,
  severity: 'warning',
  title: 'Unhandled promise',
  body: 'Floating promise may swallow errors.',
}

function toolResponse(input: unknown) {
  return { content: [{ type: 'tool_use', id: 't1', name: 'submit_findings', input }] }
}

describe('AnthropicProvider.complete', () => {
  it('forces the submit_findings tool and parses its input', async () => {
    const create = vi.fn().mockResolvedValue(toolResponse({ findings: [finding] }))
    const provider = new AnthropicProvider(
      'claude-sonnet-4-5',
      'key',
      { messages: { create } } as unknown as Anthropic,
    )
    const result = await provider.complete('system', 'user')
    expect(result).toEqual([finding])
    const body = create.mock.calls[0][0] as Record<string, unknown>
    expect(body['model']).toBe('claude-sonnet-4-5')
    expect(body['tool_choice']).toEqual({ type: 'tool', name: 'submit_findings' })
    expect((body['tools'] as { name: string }[])[0].name).toBe('submit_findings')
  })

  it('retries once when the tool input does not validate', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(toolResponse({ findings: [{ ...finding, line: 0 }] }))
      .mockResolvedValueOnce(toolResponse({ findings: [] }))
    const provider = new AnthropicProvider(
      'claude-sonnet-4-5',
      'key',
      { messages: { create } } as unknown as Anthropic,
    )
    const result = await provider.complete('system', 'user')
    expect(result).toEqual([])
    expect(create).toHaveBeenCalledTimes(2)
  })
})
