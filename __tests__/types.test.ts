import { describe, it, expect } from 'vitest'
import {
  parseFindings,
  parseAdjudication,
  AdjudicationSchema,
  ADJUDICATION_JSON_SCHEMA,
  ProviderError,
  SEVERITY_RANK,
} from '../src/providers/types'

const finding = {
  file: 'src/app.ts',
  line: 3,
  severity: 'critical',
  title: 'Remote code execution',
  body: 'eval() on user input allows arbitrary code execution.',
}

describe('parseFindings', () => {
  it('parses a plain JSON object', () => {
    expect(parseFindings(JSON.stringify({ findings: [finding] }))).toEqual([finding])
  })

  it('strips markdown code fences', () => {
    const raw = '```json\n' + JSON.stringify({ findings: [finding] }) + '\n```'
    expect(parseFindings(raw)).toEqual([finding])
  })

  it('accepts a bare findings array', () => {
    expect(parseFindings(JSON.stringify([finding]))).toEqual([finding])
  })

  it('returns empty array for empty findings', () => {
    expect(parseFindings('{"findings":[]}')).toEqual([])
  })

  it('throws ProviderError on invalid JSON', () => {
    expect(() => parseFindings('not json at all')).toThrow(ProviderError)
  })

  it('throws ProviderError naming the offending key', () => {
    const bad = JSON.stringify({ findings: [{ ...finding, severity: 'fatal' }] })
    expect(() => parseFindings(bad)).toThrow(/severity/)
  })
})

describe('SEVERITY_RANK', () => {
  it('orders critical > warning > suggestion', () => {
    expect(SEVERITY_RANK.critical).toBeGreaterThan(SEVERITY_RANK.warning)
    expect(SEVERITY_RANK.warning).toBeGreaterThan(SEVERITY_RANK.suggestion)
  })
})

describe('AdjudicationSchema and ADJUDICATION_JSON_SCHEMA', () => {
  it('validates schema and matches json schema structure', () => {
    const valid = { resolved: true, response: 'Looks good' }
    expect(AdjudicationSchema.parse(valid)).toEqual(valid)
    expect(ADJUDICATION_JSON_SCHEMA).toEqual({
      type: 'object',
      properties: {
        resolved: { type: 'boolean' },
        response: { type: 'string' },
      },
      required: ['resolved', 'response'],
      additionalProperties: false,
    })
  })
})

describe('parseAdjudication', () => {
  it('parses valid adjudication JSON', () => {
    const data = { resolved: true, response: 'The issue has been resolved.' }
    expect(parseAdjudication(JSON.stringify(data))).toEqual(data)
  })

  it('strips markdown code fences', () => {
    const data = { resolved: false, response: 'Still missing null check.' }
    const fenced = '```json\n' + JSON.stringify(data) + '\n```'
    expect(parseAdjudication(fenced)).toEqual(data)
  })

  it('throws ProviderError on invalid JSON', () => {
    expect(() => parseAdjudication('not a json')).toThrow(ProviderError)
  })

  it('throws ProviderError when schema does not match', () => {
    expect(() => parseAdjudication(JSON.stringify({ resolved: 'not-bool' }))).toThrow(ProviderError)
    expect(() => parseAdjudication(JSON.stringify({ resolved: true, response: '' }))).toThrow(ProviderError)
  })
})

