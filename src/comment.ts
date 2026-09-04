import type { Octokit } from '@octokit/core' with { 'resolution-mode': 'import' }
import {
  COMMENT_MARKER,
  SEVERITY_RANK,
  type DiffContext,
  type Finding,
  type ReviewConfig,
} from './providers/types'

export interface FilteredFindings {
  inline: Finding[]
  summaryOnly: Finding[]
}

interface ReviewComment {
  id: number
  body?: string
}

interface OctokitClient {
  paginate: (
    endpoint: unknown,
    parameters: { owner: string; repo: string; pull_number: number; per_page: number },
  ) => Promise<ReviewComment[]>
  rest: {
    pulls: {
      listReviewComments?: unknown
      deleteReviewComment: (params: {
        owner: string
        repo: string
        comment_id: number
      }) => Promise<unknown>
      createReview: (params: {
        owner: string
        repo: string
        pull_number: number
        event: string
        body: string
        comments: Array<{
          path: string
          line: number
          side: 'RIGHT'
          body: string
        }>
      }) => Promise<unknown>
    }
  }
}

export function filterFindings(
  findings: Finding[],
  diff: DiffContext,
  config: ReviewConfig,
): FilteredFindings {
  const inScope = findings.filter(
    (f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[config.severityThreshold],
  )
  const anchored: Finding[] = []
  const unanchored: Finding[] = []
  for (const f of inScope) {
    const file = diff.files.find((x) => x.path === f.file)
    if (file && file.commentableLines.includes(f.line)) anchored.push(f)
    else unanchored.push(f)
  }
  anchored.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
  const inline = anchored.slice(0, config.maxComments)
  const overflow = anchored.slice(config.maxComments)
  return { inline, summaryOnly: [...unanchored, ...overflow] }
}

export function buildSummaryBody(
  filtered: FilteredFindings,
  diff: DiffContext,
  config: ReviewConfig,
): string {
  const all = [...filtered.inline, ...filtered.summaryOnly]
  const lines: string[] = [COMMENT_MARKER, '## AI Code Review', '']
  lines.push(`Provider: ${config.provider} | Model: ${config.model}`, '')
  if (all.length === 0) {
    lines.push('**LGTM — no issues found.**')
  } else {
    const count = (s: Finding['severity']) =>
      all.filter((f) => f.severity === s).length
    lines.push(
      `**Verdict:** ${count('critical')} critical | ${count('warning')} warning | ${count('suggestion')} suggestion`,
      '',
    )
    if (filtered.summaryOnly.length > 0) {
      lines.push(
        'Findings that could not be posted inline:',
        '',
        '| Severity | Location | Issue |',
        '| --- | --- | --- |',
        ...filtered.summaryOnly.map(
          (f) => `| ${f.severity} | ${f.file}#L${f.line} | ${f.title} |`,
        ),
        '',
      )
    }
  }
  if (diff.skipped.length > 0) {
    lines.push(`> Skipped (not reviewable or out of scope): ${diff.skipped.join(', ')}`)
  }
  if (diff.truncated) {
    lines.push('> Diff was truncated to fit the model context window.')
  }
  return lines.join('\n')
}

export async function cleanupPreviousComments(
  octokit: Octokit,
  repo: { owner: string; repo: string },
  prNumber: number,
): Promise<number> {
  const client = octokit as unknown as OctokitClient
  const comments = await client.paginate(client.rest.pulls.listReviewComments, {
    owner: repo.owner,
    repo: repo.repo,
    pull_number: prNumber,
    per_page: 100,
  })
  let deleted = 0
  for (const comment of comments) {
    if (comment.body?.includes(COMMENT_MARKER)) {
      await client.rest.pulls.deleteReviewComment({
        owner: repo.owner,
        repo: repo.repo,
        comment_id: comment.id,
      })
      deleted++
    }
  }
  return deleted
}

export async function postReview(
  octokit: Octokit,
  repo: { owner: string; repo: string },
  prNumber: number,
  body: string,
  inline: Finding[],
): Promise<void> {
  const client = octokit as unknown as OctokitClient
  await client.rest.pulls.createReview({
    owner: repo.owner,
    repo: repo.repo,
    pull_number: prNumber,
    event: 'COMMENT',
    body,
    comments: inline.map((f) => ({
      path: f.file,
      line: f.line,
      side: 'RIGHT' as const,
      body: `${COMMENT_MARKER}\n**[${f.severity.toUpperCase()}] ${f.title}**\n\n${f.body}`,
    })),
  })
}
