import Anthropic from '@anthropic-ai/sdk'
import {
  FINDINGS_JSON_SCHEMA,
  parseFindings,
  REPAIR_INSTRUCTION,
  type Finding,
  type ReviewProvider,
} from './types'

export class AnthropicProvider implements ReviewProvider {
  private client: Anthropic

  constructor(
    private model: string,
    apiKey: string,
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic({ apiKey })
  }

  async complete(system: string, user: string): Promise<Finding[]> {
    const ask = async (u: string): Promise<string> => {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 8192,
        temperature: 0.1,
        system,
        messages: [{ role: 'user', content: u }],
        tools: [
          {
            name: 'submit_findings',
            description: 'Submit your code review findings',
            input_schema: FINDINGS_JSON_SCHEMA as unknown as Anthropic.Tool.InputSchema,
          },
        ],
        tool_choice: { type: 'tool', name: 'submit_findings' },
      })
      const block = response.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      )
      return block ? JSON.stringify(block.input) : ''
    }
    try {
      return parseFindings(await ask(user))
    } catch {
      return parseFindings(await ask(user + REPAIR_INSTRUCTION))
    }
  }
}
