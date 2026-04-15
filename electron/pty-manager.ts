import { BrowserWindow, app } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as crypto from 'crypto'
import type { CreatePtyOptions } from '../src/types'
import { broadcastHub } from './remote/broadcast-hub'
import { logger } from './logger'

// Per-terminal shell history directory
const historyDir = path.join(app.getPath('userData'), 'terminal-history')
const zshWrapperDir = path.join(historyDir, '.zsh-wrapper')

// Create zsh wrapper rc files that source user's originals then override HISTFILE.
// Uses env vars $_BAT_ZDOTDIR (original ZDOTDIR) and $_BAT_HISTFILE (target history file).
let zshWrapperReady = false
function ensureZshWrapper() {
  if (zshWrapperReady) return
  try {
    fs.mkdirSync(zshWrapperDir, { recursive: true })
    const src = (file: string) => `[ -f "\${_BAT_ZDOTDIR:-$HOME}/${file}" ] && source "\${_BAT_ZDOTDIR:-$HOME}/${file}"\n`
    fs.writeFileSync(path.join(zshWrapperDir, '.zshenv'), src('.zshenv'))
    fs.writeFileSync(path.join(zshWrapperDir, '.zprofile'), src('.zprofile'))
    fs.writeFileSync(path.join(zshWrapperDir, '.zshrc'), [
      src('.zshrc').trimEnd(),
      'export HISTFILE="$_BAT_HISTFILE"',
      'setopt INC_APPEND_HISTORY',
      'ZDOTDIR="${_BAT_ZDOTDIR:-$HOME}"',
      ''
    ].join('\n'))
    fs.writeFileSync(path.join(zshWrapperDir, '.zlogin'), src('.zlogin'))
    zshWrapperReady = true
    logger.log('[pty] zsh wrapper files created at', zshWrapperDir)
  } catch (e) {
    logger.warn('[pty] Failed to create zsh wrapper:', e)
  }
}

// Try to import @lydell/node-pty, fall back to child_process if not available
let pty: typeof import('@lydell/node-pty') | null = null
let ptyAvailable = false
try {
  pty = require('@lydell/node-pty')
  // Test if native module works by checking if spawn function exists and module is properly built
  if (pty && typeof pty.spawn === 'function') {
    ptyAvailable = true
    logger.log('node-pty loaded successfully (using @lydell/node-pty)')
  } else {
    logger.warn('node-pty loaded but spawn function not available')
  }
} catch (e) {
  logger.warn('@lydell/node-pty not available, falling back to child_process:', e)
}

interface PtyInstance {
  process: any // IPty or ChildProcess
  type: 'terminal'  // Unified to 'terminal' - agent types handled by agentPreset
  cwd: string
  usePty: boolean
}

export class PtyManager {
  private instances: Map<string, PtyInstance> = new Map()
  private getWindows: () => BrowserWindow[]

  constructor(getWindows: () => BrowserWindow[]) {
    this.getWindows = getWindows
  }

  private broadcast(channel: string, ...args: unknown[]) {
    for (const win of this.getWindows()) {
      if (!win.isDestroyed()) {
        try {
          win.webContents.send(channel, ...args)
        } catch {
          // Render frame may be disposed during window reload/close
        }
      }
    }
    broadcastHub.broadcast(channel, ...args)
  }

  private getDefaultShell(): string {
    if (process.platform === 'win32') {
      // Prefer PowerShell 7 (pwsh) over Windows PowerShell
      const fs = require('fs')
      const pwshPaths = [
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
        process.env.LOCALAPPDATA + '\\Microsoft\\WindowsApps\\pwsh.exe'
      ]
      for (const p of pwshPaths) {
        if (fs.existsSync(p)) {
          return p
        }
      }
      return 'powershell.exe'
    } else if (process.platform === 'darwin') {
      return process.env.SHELL || '/bin/zsh'
    } else {
      // Linux - detect available shell
      const fs = require('fs')
      if (process.env.SHELL) {
        return process.env.SHELL
      } else if (fs.existsSync('/bin/bash')) {
        return '/bin/bash'
      } else {
        return '/bin/sh'
      }
    }
  }

  create(options: CreatePtyOptions): boolean {
    const { id, cwd, type, shell: shellOverride, customEnv = {}, perTerminalHistory, historyKey } = options

    const shell = shellOverride || this.getDefaultShell()
    let args: string[] = []

    // Per-terminal HISTFILE: isolate shell history from system ~/.zsh_history
    // Uses cwd-based key so history persists across tab close/reopen in the same project.
    let histEnv: Record<string, string> = {}
    if (perTerminalHistory) {
      try {
        fs.mkdirSync(historyDir, { recursive: true })
        const key = historyKey || crypto.createHash('md5').update(id).digest('hex').slice(0, 12)
        const histFile = path.join(historyDir, `${key}_history`)

        if (shell.includes('zsh')) {
          ensureZshWrapper()
          histEnv = {
            ZDOTDIR: zshWrapperDir,
            _BAT_ZDOTDIR: process.env.ZDOTDIR || process.env.HOME || '',
            _BAT_HISTFILE: histFile,
            HISTFILE: histFile,
          }
          logger.log(`[pty] Per-terminal history (zsh wrapper): ${histFile}`)
        } else {
          histEnv = { HISTFILE: histFile }
          logger.log(`[pty] Per-terminal history: ${histFile}`)
        }
      } catch (e) {
        logger.warn('[pty] Failed to setup history:', e)
      }
    }

    // For PowerShell (pwsh or powershell), bypass execution policy to allow unsigned scripts
    if (shell.includes('powershell') || shell.includes('pwsh')) {
      args = ['-ExecutionPolicy', 'Bypass', '-NoLogo']
    } else if (process.platform === 'darwin' || process.platform === 'linux') {
      // Use login interactive shell to source profile files (.zshrc, .bashrc, .profile, etc.)
      // This ensures PATH and other environment variables are properly set
      // -l = login shell, -i = interactive shell
      args = ['-l', '-i']
    }

    // Try node-pty first, fallback to child_process if it fails
    let usedPty = false

    if (ptyAvailable && pty) {
      try {
        // Set UTF-8 and terminal environment variables, merge custom env
        const envWithUtf8 = {
          ...process.env,
          ...customEnv,  // Merge custom environment variables
          ...histEnv,    // Per-terminal HISTFILE (if enabled)
          // UTF-8 encoding
          LANG: 'en_US.UTF-8',
          LC_ALL: 'en_US.UTF-8',
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          // Terminal capabilities - let apps know we are a real PTY
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          TERM_PROGRAM: 'better-terminal',
          TERM_PROGRAM_VERSION: '1.0',
          // Force color output
          FORCE_COLOR: '3',
          // Ensure not detected as CI environment
          CI: ''
        }

        const ptyProcess = pty.spawn(shell, args, {
          name: 'xterm-256color',
          cols: 120,
          rows: 30,
          cwd,
          env: envWithUtf8 as { [key: string]: string }
        })

        ptyProcess.onData((data: string) => {
          this.broadcast('pty:output', id, data)
        })

        ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
          this.broadcast('pty:exit', id, exitCode)
          this.instances.delete(id)
        })

        this.instances.set(id, { process: ptyProcess, type, cwd, usePty: true })
        usedPty = true
        logger.log('Created terminal using node-pty')
      } catch (e) {
        logger.warn('node-pty spawn failed, falling back to child_process:', e)
        ptyAvailable = false // Don't try again
      }
    }

    if (!usedPty) {
      try {
        // Fallback to child_process with proper stdio
        // For PowerShell, add -NoExit and UTF-8 command
        let shellArgs = [...args]
        if (shell.includes('powershell') || shell.includes('pwsh')) {
          shellArgs.push(
            '-NoExit',
            '-Command',
            '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::InputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8'
          )
        }

        // Set UTF-8 and terminal environment variables, merge custom env (child_process fallback)
        const envWithUtf8 = {
          ...process.env,
          ...customEnv,  // Merge custom environment variables
          ...histEnv,    // Per-terminal HISTFILE (if enabled)
          // UTF-8 encoding
          LANG: 'en_US.UTF-8',
          LC_ALL: 'en_US.UTF-8',
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          // Terminal capabilities (limited in child_process mode)
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          TERM_PROGRAM: 'better-terminal',
          TERM_PROGRAM_VERSION: '1.0',
          FORCE_COLOR: '3',
          CI: ''
        }

        const childProcess = spawn(shell, shellArgs, {
          cwd,
          env: envWithUtf8 as NodeJS.ProcessEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false
        })

        childProcess.stdout?.on('data', (data: Buffer) => {
          this.broadcast('pty:output', id, data.toString())
        })

        childProcess.stderr?.on('data', (data: Buffer) => {
          this.broadcast('pty:output', id, data.toString())
        })

        childProcess.on('exit', (exitCode: number | null) => {
          this.broadcast('pty:exit', id, exitCode ?? 0)
          this.instances.delete(id)
        })

        childProcess.on('error', (error) => {
          logger.error('Child process error:', error)
          this.broadcast('pty:output', id, `\r\n[Error: ${error.message}]\r\n`)
        })

        // Send initial message
        this.broadcast('pty:output', id, `[Terminal - child_process mode]\r\n`)

        this.instances.set(id, { process: childProcess, type, cwd, usePty: false })
        logger.log('Created terminal using child_process fallback')
      } catch (error) {
        logger.error('Failed to create terminal:', error)
        return false
      }
    }

    return true
  }

  write(id: string, data: string): void {
    const instance = this.instances.get(id)
    if (instance) {
      if (instance.usePty) {
        instance.process.write(data)
      } else {
        // For child_process, write to stdin only (shell handles echo)
        const cp = instance.process as ChildProcess
        cp.stdin?.write(data)
      }
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const instance = this.instances.get(id)
    if (instance && instance.usePty) {
      instance.process.resize(cols, rows)
    }
  }

  kill(id: string): boolean {
    const instance = this.instances.get(id)
    if (instance) {
      const pid: number | undefined = instance.process.pid
      if (instance.usePty) {
        instance.process.kill()
      } else {
        (instance.process as ChildProcess).kill()
      }
      // On Windows, kill() only terminates the direct shell process.
      // Use taskkill /T to forcefully terminate the entire process tree.
      if (process.platform === 'win32' && pid) {
        try {
          const { execFileSync } = require('child_process')
          execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', timeout: 3000 })
        } catch { /* process may already be gone */ }
      }
      this.instances.delete(id)
      return true
    }
    return false
  }

  restart(id: string, cwd: string, shell?: string): boolean {
    const instance = this.instances.get(id)
    if (instance) {
      const type = instance.type
      this.kill(id)
      return this.create({ id, cwd, type, shell })
    }
    return false
  }

  getCwd(id: string): string | null {
    const instance = this.instances.get(id)
    if (instance) {
      return instance.cwd
    }
    return null
  }

  dispose(): void {
    for (const [id] of this.instances) {
      this.kill(id)
    }
  }
}
