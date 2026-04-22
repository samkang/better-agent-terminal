import { spawn } from 'child_process'
import { z } from 'zod'
import { tool } from 'ai'
import { getToolContext } from './context'

const MAX_OUTPUT_CHARS = 30_000
const DEFAULT_TIMEOUT_MS = 120_000

const RISKY_PATTERNS = [
  /\brm\s+-[a-z]*r[a-z]*f?\b/i,
  /\brm\s+.*\/\s*$/,
  /:(){/,
  /\bmkfs\b/i,
  /\bdd\s+if=.*of=\/dev\//i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bchmod\s+-R\s+777\b/,
  />\s*\/dev\/sd[a-z]/i,
]

function isRisky(cmd: string): boolean {
  return RISKY_PATTERNS.some(re => re.test(cmd))
}

export const bashTool = tool({
  description: 'Execute a shell command in the working directory. Returns combined stdout+stderr (truncated at 30k chars). Use for builds, tests, git, any shell operations. Avoid destructive commands.',
  inputSchema: z.object({
    command: z.string().describe('The shell command to execute'),
    description: z.string().optional().describe('Brief one-line explanation of what the command does'),
    timeoutMs: z.number().int().positive().max(600_000).optional().describe('Optional timeout in ms, default 120000'),
  }),
  execute: async ({ command, timeoutMs }, options) => {
    const ctx = getToolContext(options.experimental_context)
    const toolCallId = options.toolCallId
    const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS

    const risky = isRisky(command)
    const needsApproval =
      ctx.permissionMode === 'plan' ||
      ctx.permissionMode === 'default' ||
      (ctx.permissionMode === 'acceptEdits' && risky) ||
      risky

    if (needsApproval && ctx.permissionMode !== 'bypassPermissions') {
      const ok = await ctx.requestPermission('Bash', { command }, toolCallId)
      if (!ok) return { denied: true, error: 'User denied command execution.' }
    }

    return await new Promise<{ stdout: string; exitCode: number | null; durationMs: number; denied?: boolean; error?: string }>((resolve) => {
      const start = Date.now()
      const isWin = process.platform === 'win32'
      const shell = isWin ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh'
      const args = isWin ? ['/d', '/s', '/c', command] : ['-c', command]
      const child = spawn(shell, args, { cwd: ctx.cwd, env: process.env, windowsVerbatimArguments: isWin })
      let buf = ''
      let truncated = false

      const append = (data: Buffer) => {
        if (truncated) return
        const text = data.toString('utf8')
        if (buf.length + text.length > MAX_OUTPUT_CHARS) {
          buf += text.slice(0, MAX_OUTPUT_CHARS - buf.length)
          truncated = true
        } else {
          buf += text
        }
      }

      child.stdout.on('data', append)
      child.stderr.on('data', append)

      const killer = setTimeout(() => {
        try { child.kill('SIGTERM') } catch { /* ignore */ }
        setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, 2000)
      }, timeout)

      const onAbort = () => {
        try { child.kill('SIGTERM') } catch { /* ignore */ }
      }
      ctx.abortSignal.addEventListener('abort', onAbort, { once: true })

      child.on('close', (code) => {
        clearTimeout(killer)
        ctx.abortSignal.removeEventListener('abort', onAbort)
        const final = truncated ? buf + `\n\n[Output truncated at ${MAX_OUTPUT_CHARS} chars]` : buf
        resolve({ stdout: final, exitCode: code, durationMs: Date.now() - start })
      })

      child.on('error', (err) => {
        clearTimeout(killer)
        ctx.abortSignal.removeEventListener('abort', onAbort)
        resolve({ stdout: buf, exitCode: null, durationMs: Date.now() - start, error: err.message })
      })
    })
  },
})
