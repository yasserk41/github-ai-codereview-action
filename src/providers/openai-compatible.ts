import type OpenAI from 'openai'
import { OpenAIProvider } from './openai'

export class OpenAICompatibleProvider extends OpenAIProvider {
  protected override responseFormat(): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming['response_format'] {
    return { type: 'json_object' }
  }

  protected override adjudicationResponseFormat(): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming['response_format'] {
    return { type: 'json_object' }
  }
}
