import { existsSync } from 'fs'
import { spawn, spawnSync } from 'child_process'
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
  /\bdel\s+\/[a-z]*[sq][a-z]*\b/i,
  /\brd\s+\/s\b/i,
  /\brmdir\s+\/s\b/i,
  /\bRemove-Item\b.*\b-Recurse\b/i,
  />\s*\/dev\/sd[a-z]/i,
]

function isRisky(cmd: string): boolean {
  return RISKY_PATTERNS.some(re => re.test(cmd))
}

type ShellConfig = {
  shellPath: string
  args: string[]
  windowsVerbatimArguments?: boolean
  detached?: boolean
}

function findWindowsBash(): string | null {
  const configuredPath = process.env.BAT_BASH_PATH || process.env.GIT_BASH
  const candidates = [
    configuredPath,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  const where = spawnSync('where.exe', ['bash.exe'], { encoding: 'utf8', windowsHide: true })
  if (where.status !== 0) return null

  const discovered = where.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .find(path => existsSync(path) && !/\\Windows\\System32\\bash\.exe$/i.test(path))

  return discovered ?? null
}

function getShellConfig(command: string): ShellConfig | null {
  if (process.platform === 'win32') {
    const bashPath = findWindowsBash()
    if (!bashPath) return null
    return {
      shellPath: bashPath,
      args: ['--noprofile', '--norc', '-lc', command],
    }
  }

  return {
    shellPath: '/bin/sh',
    args: ['-c', command],
    detached: true,
  }
}

function stopProcessTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return

  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.on('error', () => { /* ignore */ })
    return
  }

  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    try { child.kill('SIGTERM') } catch { /* ignore */ }
  }
}

export const bashTool = tool({
  description: 'Execute a shell command in the working directory. On Windows, uses Git Bash when available. Returns combined stdout+stderr (truncated at 30k chars). Use for builds, tests, git, any shell operations. Avoid destructive commands.',
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
    const isStrictPlanMode = ctx.permissionMode === 'plan'
    const isBypassPlanMode = ctx.permissionMode === 'bypassPlan'
    if ((isStrictPlanMode || isBypassPlanMode) && risky) {
      return { denied: true, error: 'Risky shell commands are disabled in plan mode. Use read-only inspection commands, then request execution with ExitPlanMode.' }
    }
    const needsApproval =
      isStrictPlanMode ||
      ctx.permissionMode === 'default' ||
      (ctx.permissionMode === 'acceptEdits' && risky) ||
      risky

    if (needsApproval && ctx.permissionMode !== 'bypassPermissions') {
      const ok = await ctx.requestPermission('Bash', { command }, toolCallId)
      if (!ok) return { denied: true, error: 'User denied command execution.' }
    }

    const shellConfig = getShellConfig(command)
    if (!shellConfig) {
      return {
        stdout: '',
        exitCode: null,
        durationMs: 0,
        error: 'Git Bash was not found. Install Git for Windows or set BAT_BASH_PATH to bash.exe.',
      }
    }

    return await new Promise<{ stdout: string; exitCode: number | null; durationMs: number; denied?: boolean; error?: string }>((resolve) => {
      const start = Date.now()
      const child = spawn(shellConfig.shellPath, shellConfig.args, {
        cwd: ctx.cwd,
        env: process.env,
        windowsHide: true,
        windowsVerbatimArguments: shellConfig.windowsVerbatimArguments,
        detached: shellConfig.detached,
      })
      let buf = ''
      let truncated = false
      let timedOut = false
      let aborted = false

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
        timedOut = true
        stopProcessTree(child)
      }, timeout)

      const onAbort = () => {
        aborted = true
        stopProcessTree(child)
      }
      ctx.abortSignal.addEventListener('abort', onAbort, { once: true })

      child.on('close', (code) => {
        clearTimeout(killer)
        ctx.abortSignal.removeEventListener('abort', onAbort)
        const final = truncated ? buf + `\n\n[Output truncated at ${MAX_OUTPUT_CHARS} chars]` : buf
        resolve({
          stdout: final,
          exitCode: code,
          durationMs: Date.now() - start,
          error: timedOut ? `Command timed out after ${timeout}ms.` : aborted ? 'Command was aborted.' : undefined,
        })
      })

      child.on('error', (err) => {
        clearTimeout(killer)
        ctx.abortSignal.removeEventListener('abort', onAbort)
        resolve({ stdout: buf, exitCode: null, durationMs: Date.now() - start, error: err.message })
      })
    })
  },
})
