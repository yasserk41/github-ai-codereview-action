import OpenAI from 'openai'
import {
  FINDINGS_JSON_SCHEMA,
  ADJUDICATION_JSON_SCHEMA,
  parseFindings,
  parseAdjudication,
  REPAIR_INSTRUCTION,
  ADJUDICATION_REPAIR_INSTRUCTION,
  type Finding,
  type Adjudication,
  type ReviewProvider,
} from './types'

export class OpenAIProvider implements ReviewProvider {
  protected client: OpenAI

  constructor(
    protected model: string,
    apiKey: string,
    baseUrl?: string,
    client?: OpenAI,
  ) {
    this.client =
      client ?? new OpenAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) })
  }

  protected responseFormat(): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming['response_format'] {
    return {
      type: 'json_schema',
      json_schema: { name: 'findings', strict: true, schema: FINDINGS_JSON_SCHEMA },
    }
  }

  protected adjudicationResponseFormat(): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming['response_format'] {
    return {
      type: 'json_schema',
      json_schema: { name: 'adjudication', strict: true, schema: ADJUDICATION_JSON_SCHEMA },
    }
  }

  async complete(system: string, user: string): Promise<Finding[]> {
    const ask = async (u: string): Promise<string> => {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0.1,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: u },
        ],
        ...(this.responseFormat() ? { response_format: this.responseFormat() } : {}),
      })
      return response.choices[0]?.message?.content ?? ''
    }
    try {
      return parseFindings(await ask(user))
    } catch {
      return parseFindings(await ask(user + REPAIR_INSTRUCTION))
    }
  }

  async adjudicate(system: string, user: string): Promise<Adjudication> {
    const ask = async (u: string): Promise<string> => {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0.1,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: u },
        ],
        ...(this.adjudicationResponseFormat()
          ? { response_format: this.adjudicationResponseFormat() }
          : {}),
      })
      return response.choices[0]?.message?.content ?? ''
    }
    try {
      return parseAdjudication(await ask(user))
    } catch {
      return parseAdjudication(await ask(user + ADJUDICATION_REPAIR_INSTRUCTION))
    }
  }
}
