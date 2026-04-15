import { BrowserWindow, app } from 'electron'
import { execSync } from 'child_process'
import * as pathModule from 'path'
import type { ClaudeMessage, ClaudeToolCall, ClaudeSessionState } from '../src/types/claude-agent'
import { logger } from './logger'
import { broadcastHub } from './remote/broadcast-hub'

type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never'

interface SessionMetadata {
  model?: string
  sdkSessionId?: string
  cwd?: string
  totalCost: number
  inputTokens: number
  outputTokens: number
  durationMs: number
  numTurns: number
  contextWindow: number
  maxOutputTokens: number
  contextTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  callCacheRead: number
  callCacheWrite: number
  lastQueryCalls: number
}

interface QueuedMessage {
  prompt: string
  images?: string[]
}

interface CodexSessionInstance {
  abortController: AbortController
  state: ClaudeSessionState
  threadId?: string
  cwd: string
  metadata: SessionMetadata
  codexInstance?: unknown
  thread?: unknown
  sandboxMode: CodexSandboxMode
  approvalPolicy: CodexApprovalPolicy
  model?: string
  messageQueue: QueuedMessage[]
  currentPrompt?: string
  isResting?: boolean
  isRunning?: boolean
  startTime?: number
}

// Lazy SDK import
let CodexClass: unknown = null

async function getCodexClass(): Promise<unknown> {
  if (!CodexClass) {
    try {
      const sdk = await import('@openai/codex-sdk')
      CodexClass = (sdk as Record<string, unknown>).Codex || (sdk as Record<string, unknown>).default
    } catch (err) {
      logger.error('[codex] Failed to import @openai/codex-sdk:', err)
      throw new Error('Codex SDK not available. Install with: npm i -g @openai/codex')
    }
  }
  return CodexClass
}

function findCodexBinary(): string | undefined {
  try {
    return execSync('which codex', { encoding: 'utf-8', timeout: 3000 }).trim() || undefined
  } catch {
    return undefined
  }
}

const CODEX_MODELS: Array<{ value: string; displayName: string; description: string }> = [
  { value: 'o3', displayName: 'o3', description: 'OpenAI o3 · reasoning model' },
  { value: 'o4-mini', displayName: 'o4-mini', description: 'OpenAI o4-mini · fast & efficient' },
  { value: 'gpt-4.1', displayName: 'GPT-4.1', description: 'OpenAI GPT-4.1 · latest GPT' },
  { value: 'codex-mini-latest', displayName: 'Codex Mini', description: 'codex-mini · optimized for code' },
]

const sdkThreadIds = new Map<string, string>()

export class CodexAgentManager {
  private sessions: Map<string, CodexSessionInstance> = new Map()
  private getWindows: () => BrowserWindow[]

  constructor(getWindows: () => BrowserWindow[]) {
    this.getWindows = getWindows
  }

  private send(channel: string, ...args: unknown[]) {
    for (const win of this.getWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, ...args)
      }
    }
    broadcastHub.broadcast(channel, ...args)
  }

  private static readonly MSG_BUFFER_CAP = 300

  private addMessage(sessionId: string, msg: ClaudeMessage) {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.state.messages.push(msg)
      if (session.state.messages.length > CodexAgentManager.MSG_BUFFER_CAP) {
        session.state.messages = session.state.messages.slice(-CodexAgentManager.MSG_BUFFER_CAP)
      }
    }
    this.send('claude:message', sessionId, msg)
  }

  private addToolCall(sessionId: string, tool: ClaudeToolCall) {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.state.messages.push(tool)
      if (session.state.messages.length > CodexAgentManager.MSG_BUFFER_CAP) {
        session.state.messages = session.state.messages.slice(-CodexAgentManager.MSG_BUFFER_CAP)
      }
    }
    this.send('claude:tool-use', sessionId, tool)
  }

  private updateToolCall(sessionId: string, toolId: string, updates: Partial<ClaudeToolCall>) {
    const session = this.sessions.get(sessionId)
    if (session) {
      const idx = session.state.messages.findIndex(
        m => 'toolName' in m && m.id === toolId
      )
      if (idx !== -1) {
        Object.assign(session.state.messages[idx], updates)
      }
    }
    this.send('claude:tool-result', sessionId, { id: toolId, ...updates })
  }

  private makeMetadata(): SessionMetadata {
    return {
      totalCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
      numTurns: 0,
      contextWindow: 0,
      maxOutputTokens: 0,
      contextTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      callCacheRead: 0,
      callCacheWrite: 0,
      lastQueryCalls: 0,
    }
  }

  async startSession(sessionId: string, options: {
    cwd: string
    prompt?: string
    permissionMode?: string
    model?: string
    effort?: string
    apiVersion?: string
    codexSandboxMode?: CodexSandboxMode
    codexApprovalPolicy?: CodexApprovalPolicy
    agentPreset?: string
    [key: string]: unknown
  }): Promise<boolean> {
    if (this.sessions.has(sessionId)) return true

    const codexPath = findCodexBinary()
    if (!codexPath) {
      this.send('claude:error', sessionId, 'Codex CLI not found. Install with: npm i -g @openai/codex or brew install --cask codex')
      return false
    }

    const stag = `[codex:${sessionId.slice(0, 8)}]`
    logger.log(`${stag} Starting session cwd=${options.cwd} model=${options.model || 'default'}`)

    const sandboxMode = options.codexSandboxMode || 'workspace-write'
    const approvalPolicy = options.codexApprovalPolicy || 'on-request'

    const session: CodexSessionInstance = {
      abortController: new AbortController(),
      state: { sessionId, messages: [], isStreaming: false },
      cwd: options.cwd,
      metadata: {
        ...this.makeMetadata(),
        model: options.model,
        cwd: options.cwd,
      },
      sandboxMode,
      approvalPolicy,
      model: options.model,
      messageQueue: [],
      startTime: Date.now(),
    }

    this.sessions.set(sessionId, session)

    // Send init message
    this.addMessage(sessionId, {
      id: `sys-init-${Date.now()}`,
      sessionId,
      role: 'system',
      content: `Codex session started (sandbox: ${sandboxMode}, approval: ${approvalPolicy})`,
      timestamp: Date.now(),
    })

    // Create Codex instance and thread
    try {
      const Codex = await getCodexClass() as new (opts: Record<string, unknown>) => unknown
      const codex = new Codex({
        codexPathOverride: codexPath,
      })
      session.codexInstance = codex

      const threadOpts: Record<string, unknown> = {
        workingDirectory: options.cwd,
        sandboxMode,
        approvalPolicy,
      }
      if (options.model) threadOpts.model = options.model

      const savedThreadId = sdkThreadIds.get(sessionId)
      let thread: unknown
      if (savedThreadId) {
        logger.log(`${stag} Resuming thread ${savedThreadId.slice(0, 8)}`)
        thread = (codex as Record<string, (id: string) => unknown>).resumeThread(savedThreadId)
      } else {
        thread = (codex as Record<string, (opts: Record<string, unknown>) => unknown>).startThread(threadOpts)
      }
      session.thread = thread

      // Extract thread ID if available
      const threadId = (thread as Record<string, unknown>)?.id as string | undefined
      if (threadId) {
        session.threadId = threadId
        session.metadata.sdkSessionId = threadId
        sdkThreadIds.set(sessionId, threadId)
      }

      this.send('claude:status', sessionId, { ...session.metadata })

      // If a prompt was provided, send it immediately
      if (options.prompt) {
        await this.sendMessage(sessionId, options.prompt)
      }

      return true
    } catch (err) {
      logger.error(`${stag} Failed to create Codex session:`, err)
      this.send('claude:error', sessionId, `Failed to start Codex: ${err instanceof Error ? err.message : String(err)}`)
      this.sessions.delete(sessionId)
      return false
    }
  }

  async sendMessage(sessionId: string, prompt: string, _images?: string[]): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session || !session.thread) return false

    if (session.isRunning) {
      session.messageQueue.push({ prompt })
      return true
    }

    const stag = `[codex:${sessionId.slice(0, 8)}]`
    session.isRunning = true
    session.currentPrompt = prompt
    session.state.isStreaming = true

    // Add user message to UI
    this.addMessage(sessionId, {
      id: `user-${Date.now()}`,
      sessionId,
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    })

    const turnStart = Date.now()
    let currentAssistantText = ''
    let currentThinkingText = ''
    let currentItemId = ''

    try {
      const thread = session.thread as Record<string, (prompt: string) => Promise<{ events: AsyncIterable<Record<string, unknown>> }>>
      const { events } = await thread.runStreamed(prompt)

      for await (const event of events) {
        if (session.abortController.signal.aborted) break

        const type = event.type as string
        logger.log(`${stag} event: ${type}`)

        switch (type) {
          case 'thread.started': {
            const threadId = event.threadId as string | undefined
            if (threadId && !session.threadId) {
              session.threadId = threadId
              session.metadata.sdkSessionId = threadId
              sdkThreadIds.set(sessionId, threadId)
              this.send('claude:status', sessionId, { ...session.metadata })
            }
            break
          }

          case 'turn.started':
            session.metadata.numTurns++
            break

          case 'item.started': {
            const item = event.item as Record<string, unknown>
            const itemType = item?.type as string
            currentItemId = (item?.id as string) || `item-${Date.now()}`

            if (itemType === 'agent_message') {
              currentAssistantText = ''
              currentThinkingText = ''
            } else if (itemType === 'reasoning') {
              // Reasoning/thinking block
            } else if (itemType === 'command_execution') {
              const command = (item?.command as string) || (item?.input as string) || ''
              this.addToolCall(sessionId, {
                id: currentItemId,
                sessionId,
                toolName: 'Bash',
                input: { command },
                status: 'running',
                timestamp: Date.now(),
              })
            } else if (itemType === 'file_change') {
              const changes = item?.changes as Array<Record<string, unknown>> | undefined
              const filePath = changes?.[0]?.path as string || ''
              this.addToolCall(sessionId, {
                id: currentItemId,
                sessionId,
                toolName: 'Edit',
                input: { file_path: filePath },
                status: 'running',
                timestamp: Date.now(),
              })
            } else if (itemType === 'mcp_tool_call') {
              const toolName = (item?.tool as string) || 'MCP'
              this.addToolCall(sessionId, {
                id: currentItemId,
                sessionId,
                toolName,
                input: (item?.arguments as Record<string, unknown>) || {},
                status: 'running',
                timestamp: Date.now(),
              })
            } else if (itemType === 'web_search') {
              this.addToolCall(sessionId, {
                id: currentItemId,
                sessionId,
                toolName: 'WebSearch',
                input: { query: (item?.query as string) || '' },
                status: 'running',
                timestamp: Date.now(),
              })
            }
            break
          }

          case 'item.updated': {
            const item = event.item as Record<string, unknown>
            const itemType = item?.type as string

            if (itemType === 'agent_message') {
              const text = (item?.text as string) || (item?.content as string) || ''
              if (text && text.length > currentAssistantText.length) {
                const delta = text.slice(currentAssistantText.length)
                currentAssistantText = text
                this.send('claude:stream', sessionId, { text: delta })
              }
            } else if (itemType === 'reasoning') {
              const text = (item?.text as string) || (item?.content as string) || ''
              if (text && text.length > currentThinkingText.length) {
                const delta = text.slice(currentThinkingText.length)
                currentThinkingText = text
                this.send('claude:stream', sessionId, { thinking: delta })
              }
            }
            break
          }

          case 'item.completed': {
            const item = event.item as Record<string, unknown>
            const itemType = item?.type as string
            const itemId = (item?.id as string) || currentItemId

            if (itemType === 'agent_message') {
              const text = (item?.text as string) || (item?.content as string) || currentAssistantText
              this.addMessage(sessionId, {
                id: `msg-${Date.now()}`,
                sessionId,
                role: 'assistant',
                content: text,
                thinking: currentThinkingText || undefined,
                timestamp: Date.now(),
              })
              currentAssistantText = ''
              currentThinkingText = ''
            } else if (itemType === 'command_execution') {
              const output = (item?.output as string) || (item?.result as string) || ''
              const status = (item?.status as string) === 'failed' ? 'error' : 'completed'
              this.updateToolCall(sessionId, itemId, {
                status: status as 'completed' | 'error',
                result: output,
              })
            } else if (itemType === 'file_change') {
              const changes = item?.changes as Array<Record<string, unknown>> | undefined
              const diff = changes?.map(c => c.diff || `${c.kind}: ${c.path}`).join('\n') || 'File changed'
              this.updateToolCall(sessionId, itemId, {
                status: 'completed',
                result: diff as string,
              })
            } else if (itemType === 'mcp_tool_call') {
              const result = item?.result !== undefined ? JSON.stringify(item.result) : ''
              const status = (item?.status as string) === 'failed' ? 'error' : 'completed'
              this.updateToolCall(sessionId, itemId, {
                status: status as 'completed' | 'error',
                result,
              })
            } else if (itemType === 'web_search') {
              this.updateToolCall(sessionId, itemId, {
                status: 'completed',
                result: 'Search completed',
              })
            } else if (itemType === 'error') {
              const errMsg = (item?.message as string) || (item?.error as string) || 'Unknown error'
              this.send('claude:error', sessionId, errMsg)
            }
            break
          }

          case 'turn.completed': {
            const usage = event.usage as { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } | undefined
            if (usage) {
              session.metadata.inputTokens += usage.input_tokens || 0
              session.metadata.outputTokens += usage.output_tokens || 0
              session.metadata.cacheReadTokens += usage.cached_input_tokens || 0
              session.metadata.lastQueryCalls = 1
            }
            session.metadata.durationMs = Date.now() - (session.startTime || turnStart)
            this.send('claude:status', sessionId, { ...session.metadata })

            this.send('claude:result', sessionId, {
              subtype: 'result',
              totalCost: session.metadata.totalCost,
              totalTokens: session.metadata.inputTokens + session.metadata.outputTokens,
              result: currentAssistantText || undefined,
            })
            break
          }

          case 'turn.failed': {
            const errMsg = (event.error as string) || 'Turn failed'
            logger.error(`${stag} Turn failed: ${errMsg}`)
            this.send('claude:error', sessionId, errMsg)
            break
          }

          case 'error': {
            const errMsg = (event.error as string) || 'Unknown error'
            logger.error(`${stag} Error: ${errMsg}`)
            this.send('claude:error', sessionId, errMsg)
            break
          }
        }
      }
    } catch (err) {
      if (!session.abortController.signal.aborted) {
        logger.error(`${stag} Query error:`, err)
        this.send('claude:error', sessionId, `Codex error: ${err instanceof Error ? err.message : String(err)}`)
      }
    } finally {
      session.isRunning = false
      session.state.isStreaming = false
      session.currentPrompt = undefined

      // Process queued messages
      const next = session.messageQueue.shift()
      if (next) {
        await this.sendMessage(sessionId, next.prompt, next.images)
      }
    }

    return true
  }

  async stopSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.abortController.abort()
    session.state.isStreaming = false
    session.isRunning = false
    return true
  }

  abortSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.abortController.abort()
    session.state.isStreaming = false
    session.isRunning = false
    this.sessions.delete(sessionId)
    return true
  }

  async resetSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) return false

    session.abortController.abort()
    session.state = { sessionId, messages: [], isStreaming: false }
    session.metadata = { ...this.makeMetadata(), model: session.model, cwd: session.cwd }
    session.thread = undefined
    session.threadId = undefined
    session.isRunning = false
    sdkThreadIds.delete(sessionId)
    this.send('claude:session-reset', sessionId)

    // Create a new thread
    session.abortController = new AbortController()
    try {
      const codex = session.codexInstance as Record<string, (opts: Record<string, unknown>) => unknown>
      const threadOpts: Record<string, unknown> = {
        workingDirectory: session.cwd,
        sandboxMode: session.sandboxMode,
        approvalPolicy: session.approvalPolicy,
      }
      if (session.model) threadOpts.model = session.model
      session.thread = codex.startThread(threadOpts)
      const threadId = (session.thread as Record<string, unknown>)?.id as string | undefined
      if (threadId) {
        session.threadId = threadId
        session.metadata.sdkSessionId = threadId
        sdkThreadIds.set(sessionId, threadId)
      }
    } catch (err) {
      logger.error(`[codex:${sessionId.slice(0, 8)}] Reset failed:`, err)
    }
    return true
  }

  restSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.abortController.abort()
    session.isResting = true
    session.state.isStreaming = false
    session.isRunning = false
    session.codexInstance = undefined
    session.thread = undefined
    return true
  }

  wakeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.isResting = false
    session.abortController = new AbortController()
    return true
  }

  isResting(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.isResting ?? false
  }

  async resumeSession(sessionId: string, threadId: string, cwd: string, model?: string): Promise<boolean> {
    sdkThreadIds.set(sessionId, threadId)
    return this.startSession(sessionId, { cwd, model })
  }

  getSessionState(sessionId: string): ClaudeSessionState | null {
    return this.sessions.get(sessionId)?.state ?? null
  }

  getSessionMeta(sessionId: string): Record<string, unknown> | null {
    const session = this.sessions.get(sessionId)
    return session ? { ...session.metadata } : null
  }

  async getSupportedModels(_sessionId: string): Promise<Array<{ value: string; displayName: string; description: string; source: string }>> {
    return CODEX_MODELS.map(m => ({ ...m, source: 'builtin' }))
  }

  setModel(sessionId: string, model: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.model = model
    session.metadata.model = model
    this.send('claude:status', sessionId, { ...session.metadata })
    return true
  }

  setPermissionMode(_sessionId: string, _mode: string): boolean {
    return false
  }

  setEffort(_sessionId: string, _effort: string): boolean {
    return true
  }

  async stopTask(_sessionId: string, _taskId: string): Promise<boolean> {
    return false
  }

  async getAccountInfo(_sessionId: string): Promise<null> { return null }
  async getSupportedCommands(_sessionId: string): Promise<[]> { return [] }
  async getSupportedAgents(_sessionId: string): Promise<[]> { return [] }
  async getContextUsage(_sessionId: string): Promise<null> { return null }
  async forkSession(_sessionId: string): Promise<null> { return null }
  async fetchSubagentMessages(_sessionId: string, _agentToolUseId: string): Promise<[]> { return [] }
  async getWorktreeStatus(_sessionId: string): Promise<null> { return null }
  async cleanupWorktree(_sessionId: string, _deleteBranch?: boolean): Promise<boolean> { return false }

  resolvePermission(_sessionId: string, _toolUseId: string, _result: unknown): boolean { return false }
  resolveAskUser(_sessionId: string, _toolUseId: string, _answers: unknown): boolean { return false }

  async listSessions(_cwd: string): Promise<[]> {
    // TODO: Read from ~/.codex/sessions if available
    return []
  }

  killAll(): void {
    for (const [, session] of this.sessions) {
      session.abortController.abort()
    }
    this.sessions.clear()
  }

  dispose(): void {
    this.killAll()
  }
}
