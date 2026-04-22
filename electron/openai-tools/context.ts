import type { ClaudeToolCall } from '../../src/types/claude-agent'
import type { SkillMeta } from '../openai-agent/skills-scanner'

export type OpenAIPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'

export interface OpenAIToolContext {
  sessionId: string
  cwd: string
  permissionMode: OpenAIPermissionMode
  abortSignal: AbortSignal
  requestPermission: (toolName: string, input: Record<string, unknown>, toolCallId: string) => Promise<boolean>
  addToolCall: (tool: ClaudeToolCall) => void
  updateToolCall: (id: string, updates: Partial<ClaudeToolCall>) => void
  skills: Map<string, SkillMeta>
}

export const TOOL_CONTEXT_KEY = Symbol.for('bat.openai.toolContext')

export function getToolContext(ctx: unknown): OpenAIToolContext {
  const bag = ctx as Record<string | symbol, unknown> | undefined
  const tc = bag?.[TOOL_CONTEXT_KEY] as OpenAIToolContext | undefined
  if (!tc) throw new Error('Tool execution context missing; this tool must be invoked via the OpenAI agent manager.')
  return tc
}
