import type { ClaudeMessage, ClaudeToolCall } from '../../src/types/claude-agent'

export const PRUNE_MINIMUM = 20_000
export const TOOL_OUTPUT_MAX_CHARS = 2_000
export const DEFAULT_TAIL_TURNS = 2
export const OVERFLOW_BUFFER = 4_000

export type HistoryItem = ClaudeMessage | ClaudeToolCall

export function needsCompaction(params: { totalTokens: number; modelMaxInput: number }): boolean {
  if (params.totalTokens < PRUNE_MINIMUM) return false
  return params.totalTokens > params.modelMaxInput - OVERFLOW_BUFFER
}

function isUser(m: HistoryItem): boolean {
  return 'role' in m && m.role === 'user'
}

export function splitForCompaction(messages: HistoryItem[], tailTurns: number = DEFAULT_TAIL_TURNS): { head: HistoryItem[]; tail: HistoryItem[] } {
  let userCount = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isUser(messages[i])) {
      userCount++
      if (userCount >= tailTurns) {
        return { head: messages.slice(0, i), tail: messages.slice(i) }
      }
    }
  }
  return { head: [], tail: messages.slice() }
}

export function truncateToolOutputs(items: HistoryItem[]): HistoryItem[] {
  return items.map(item => {
    if ('toolName' in item && item.result && item.result.length > TOOL_OUTPUT_MAX_CHARS) {
      return { ...item, result: item.result.slice(0, TOOL_OUTPUT_MAX_CHARS) + `\n… [truncated ${item.result.length - TOOL_OUTPUT_MAX_CHARS} chars for compaction]` }
    }
    return item
  })
}

export function buildCompactionPrompt(head: HistoryItem[]): string {
  const rendered: string[] = []
  for (const item of head) {
    if ('role' in item) {
      if (item.role === 'system') continue
      rendered.push(`[${item.role}] ${item.content}`)
    } else {
      rendered.push(`[tool:${item.toolName}] input=${safeStringify(item.input).slice(0, 500)} result=${(item.result || '').slice(0, 500)}`)
    }
  }
  return `Summarize the prior conversation for future reference. Produce concise Markdown with these sections:
- Goal
- Constraints
- Progress (completed / partial)
- Decisions
- Next
- Files touched

Conversation so far:

${rendered.join('\n\n')}`
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v) } catch { return String(v) }
}
