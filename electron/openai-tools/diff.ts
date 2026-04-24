import * as path from 'path'

const DEFAULT_CONTEXT_LINES = 3
const DEFAULT_MAX_CHARS = 12_000

export function createUnifiedDiffPreview(
  filePath: string,
  before: string | null,
  after: string,
  cwd: string,
  maxChars = DEFAULT_MAX_CHARS,
): string {
  const rel = path.relative(cwd, filePath) || filePath
  const oldLabel = before === null ? '/dev/null' : `a/${rel}`
  const newLabel = `b/${rel}`
  const beforeLines = before === null ? [] : before.split('\n')
  const afterLines = after.split('\n')

  let prefix = 0
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix++
  }

  let suffix = 0
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix++
  }

  const oldStart = Math.max(0, prefix - DEFAULT_CONTEXT_LINES)
  const newStart = Math.max(0, prefix - DEFAULT_CONTEXT_LINES)
  const oldEnd = Math.min(beforeLines.length, beforeLines.length - suffix + DEFAULT_CONTEXT_LINES)
  const newEnd = Math.min(afterLines.length, afterLines.length - suffix + DEFAULT_CONTEXT_LINES)
  const oldChangedStart = prefix
  const oldChangedEnd = beforeLines.length - suffix
  const newChangedStart = prefix
  const newChangedEnd = afterLines.length - suffix

  const out: string[] = [
    `--- ${oldLabel}`,
    `+++ ${newLabel}`,
    `@@ -${oldStart + 1},${Math.max(0, oldEnd - oldStart)} +${newStart + 1},${Math.max(0, newEnd - newStart)} @@`,
  ]

  for (let i = oldStart; i < oldChangedStart; i++) out.push(` ${beforeLines[i] ?? ''}`)
  for (let i = oldChangedStart; i < oldChangedEnd; i++) out.push(`-${beforeLines[i] ?? ''}`)
  for (let i = newChangedStart; i < newChangedEnd; i++) out.push(`+${afterLines[i] ?? ''}`)
  for (let i = oldChangedEnd; i < oldEnd; i++) out.push(` ${beforeLines[i] ?? ''}`)

  const diff = out.join('\n')
  return diff.length > maxChars ? `${diff.slice(0, maxChars)}\n\n[Diff preview truncated]` : diff
}
