import type { DiffContext, ReviewConfig } from './providers/types'

export function buildSystemPrompt(config: ReviewConfig): string {
  const focus =
    config.reviewStyle === 'thorough'
      ? 'You review code thoroughly: correctness, security, performance, style, naming, and documentation.'
      : 'You review code for high-signal issues only: bugs, security vulnerabilities, logic errors, and performance problems. Do not comment on style or formatting unless it causes a real problem.'
  return [
    'You are an expert code reviewer embedded in a CI pipeline.',
    focus,
    '',
    'Severity levels:',
    '- critical: bugs that break functionality, security vulnerabilities, data loss',
    '- warning: likely bugs, risky patterns, performance issues',
    '- suggestion: meaningful improvements worth considering',
    '',
    'Rules:',
    '- Only report findings anchored to a specific line of the provided diff (use right-side line numbers).',
    '- Only report issues in lines the diff touches or lines directly adjacent to them.',
    '- If the code is fine, return an empty findings array.',
    '- Respond ONLY with JSON of the form {"findings":[{"file":string,"line":integer,"severity":"critical"|"warning"|"suggestion","title":string,"body":string}]}.',
    config.customInstructions
      ? `\nProject-specific instructions from the maintainers (follow closely):\n${config.customInstructions}`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export function buildUserPrompt(
  diff: DiffContext,
  pr: { title: string; body: string },
): string {
  const sections = diff.files
    .map((f) => `### ${f.path}\n\`\`\`diff\n${f.patch}\n\`\`\``)
    .join('\n\n')
  const header = `Pull request: ${pr.title}\n\n${pr.body || '(no description)'}`
  return `${header}\n\nDiff to review (right-side line numbers are inside the @@ hunk headers):\n\n${sections}`
}
