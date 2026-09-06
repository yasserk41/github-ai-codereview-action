import { describe, it, expect, vi } from 'vitest'
import * as core from '@actions/core'
import { context } from '@actions/github'
import { describeError, run } from '../src/main'
import { ConfigError } from '../src/providers/types'
import { ProviderConfigError } from '../src/providers/registry'
import * as replyModule from '../src/reply'
import * as configModule from '../src/config'
import * as registryModule from '../src/providers/registry'

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

describe('main run event routing', () => {
  it('logs and returns when adjudicateReplies is false for reply event', async () => {
    const infoSpy = vi.spyOn(core, 'info').mockImplementation(() => {})
    const origEvent = context.eventName
    const origAction = context.action
    const origPayload = context.payload
    try {
      context.eventName = 'pull_request_review_comment'
      context.action = 'created'
      context.payload = {
        comment: { id: 10, in_reply_to_id: 5 },
        pull_request: { number: 1, head: { sha: 'sha' } },
      }
      vi.spyOn(configModule, 'readRawInputs').mockReturnValue({
        provider: 'openai',
        model: '',
        baseUrl: '',
        contextWindow: '',
        githubToken: 't',
        configPath: '',
        verdict: 'comment',
        requestChangesOn: 'critical',
        adjudicateReplies: false,
      })

      await run()
      expect(infoSpy).toHaveBeenCalledWith('Reply adjudication disabled')
    } finally {
      context.eventName = origEvent
      context.action = origAction
      context.payload = origPayload
      vi.restoreAllMocks()
    }
  })

  it('logs and returns when comment is not a reply', async () => {
    const infoSpy = vi.spyOn(core, 'info').mockImplementation(() => {})
    const origEvent = context.eventName
    const origAction = context.action
    const origPayload = context.payload
    try {
      context.eventName = 'pull_request_review_comment'
      context.action = 'created'
      context.payload = {
        comment: { id: 10 },
        pull_request: { number: 1, head: { sha: 'sha' } },
      }
      vi.spyOn(configModule, 'readRawInputs').mockReturnValue({
        provider: 'openai',
        model: '',
        baseUrl: '',
        contextWindow: '',
        githubToken: 't',
        configPath: '',
        verdict: 'comment',
        requestChangesOn: 'critical',
        adjudicateReplies: true,
      })

      await run()
      expect(infoSpy).toHaveBeenCalledWith('Not a reply; nothing to do.')
    } finally {
      context.eventName = origEvent
      context.action = origAction
      context.payload = origPayload
      vi.restoreAllMocks()
    }
  })

  it('routes to runReplyReview and sets output when event is valid reply', async () => {
    const setOutputSpy = vi.spyOn(core, 'setOutput').mockImplementation(() => {})
    const infoSpy = vi.spyOn(core, 'info').mockImplementation(() => {})
    const origEvent = context.eventName
    const origAction = context.action
    const origPayload = context.payload
    const origRepo = process.env.GITHUB_REPOSITORY
    try {
      process.env.GITHUB_REPOSITORY = 'test-owner/test-repo'
      context.eventName = 'pull_request_review_comment'
      context.action = 'created'
      context.payload = {
        comment: { id: 10, in_reply_to_id: 5, user: { login: 'dev' } },
        pull_request: { number: 1, head: { sha: 'sha' } },
      }
      vi.spyOn(configModule, 'readRawInputs').mockReturnValue({
        provider: 'openai',
        model: '',
        baseUrl: '',
        contextWindow: '',
        githubToken: 't',
        configPath: '',
        verdict: 'comment',
        requestChangesOn: 'critical',
        adjudicateReplies: true,
      })
      vi.spyOn(registryModule, 'createProvider').mockReturnValue({
        complete: vi.fn(),
        adjudicate: vi.fn(),
      })
      vi.spyOn(replyModule, 'runReplyReview').mockResolvedValue({
        outcome: 'resolved',
      })

      await run()
      expect(replyModule.runReplyReview).toHaveBeenCalledWith(
        expect.objectContaining({
          commentId: 10,
          commentAuthor: 'dev',
          headSha: 'sha',
          prNumber: 1,
        }),
      )
      expect(setOutputSpy).toHaveBeenCalledWith('adjudication', 'resolved')
      expect(infoSpy).toHaveBeenCalledWith('Reply adjudication: resolved')
    } finally {
      process.env.GITHUB_REPOSITORY = origRepo
      context.eventName = origEvent
      context.action = origAction
      context.payload = origPayload
      vi.restoreAllMocks()
    }
  })
})

