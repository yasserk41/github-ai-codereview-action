import { z } from 'zod'

export const SEVERITIES = ['critical', 'warning', 'suggestion'] as const
export type Severity = (typeof SEVERITIES)[number]

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 3,
  warning: 2,
  suggestion: 1,
}

export const FindingSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  severity: z.enum(SEVERITIES),
  title: z.string().min(1),
  body: z.string().min(1),
})

export type Finding = z.infer<typeof FindingSchema>

export const FindingsPayloadSchema = z.object({
  findings: z.array(FindingSchema),
})

export class ProviderError extends Error {
  constructor(message: string, readonly raw?: string) {
    super(message)
    this.name = 'ProviderError'
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export function parseFindings(raw: string): Finding[] {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  let json: unknown
  try {
    json = JSON.parse(stripped)
  } catch {
    throw new ProviderError('LLM response was not valid JSON', raw)
  }
  if (Array.isArray(json)) json = { findings: json }
  const parsed = FindingsPayloadSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new ProviderError(
      `LLM JSON did not match findings schema at "${issue.path.join('.')}": ${issue.message}`,
      raw,
    )
  }
  return parsed.data.findings
}

export const FINDINGS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['critical', 'warning', 'suggestion'] },
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['file', 'line', 'severity', 'title', 'body'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
} as const

export const REPAIR_INSTRUCTION =
  '\n\nIMPORTANT: Your previous response was not valid JSON matching the required schema. Respond again with ONLY the JSON object {"findings":[...]}. No prose, no markdown fences.'

export const COMMENT_MARKER = '<!-- ai-code-review-action -->'

export interface FileDiff {
  path: string
  patch: string
  commentableLines: number[]
}

export interface DiffContext {
  files: FileDiff[]
  truncated: boolean
  skipped: string[]
  estimatedTokens: number
}

export interface ReviewConfig {
  provider: string
  model: string
  contextWindowTokens: number
  maxComments: number
  reviewStyle: 'high-signal' | 'thorough'
  severityThreshold: Severity
  customInstructions?: string
  verdict: 'comment' | 'auto'
  requestChangesOn: Severity
}

export interface ReviewProvider {
  complete(system: string, user: string): Promise<Finding[]>
}
