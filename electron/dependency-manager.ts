import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as fsPromises from 'fs/promises'
import * as path from 'path'
import { logger } from './logger'
import { getDataDir } from './server-core/data-dir'

const execFileAsync = promisify(execFile)
const MIN_GLOBAL_VIRTUAL_STORE_VERSION = [10, 12, 1] as const
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000
const OUTPUT_LIMIT = 24 * 1024

interface DependencySettings {
  worktreePnpmInstallEnabled?: boolean
}

interface WorktreeDependencyTarget {
  sessionId: string
  worktreePath: string
  gitRoot: string
  branchName: string
}

interface PnpmCommand {
  command: string
  argsPrefix: string[]
  version: string
}

interface InstallPlan {
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  storeDir: string
  version: string
}

function trimOutput(current: string, chunk: Buffer): string {
  const next = current + chunk.toString('utf8')
  if (next.length <= OUTPUT_LIMIT) return next
  return next.slice(next.length - OUTPUT_LIMIT)
}

function parseVersion(version: string): [number, number, number] | null {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function isAtLeast(version: string, minimum: readonly [number, number, number]): boolean {
  const parsed = parseVersion(version)
  if (!parsed) return false
  for (let i = 0; i < minimum.length; i++) {
    if (parsed[i] > minimum[i]) return true
    if (parsed[i] < minimum[i]) return false
  }
  return true
}

export class DependencyManager {
  private running = new Set<string>()

  queueWorktreeInstall(target: WorktreeDependencyTarget): void {
    if (this.running.has(target.worktreePath)) return
    void this.installForWorktree(target).catch(err => {
      logger.warn(`[deps] Failed to start worktree dependency install for ${target.worktreePath}:`, err)
      this.running.delete(target.worktreePath)
    })
  }

  private async installForWorktree(target: WorktreeDependencyTarget): Promise<void> {
    const settings = await this.readSettings()
    if (settings.worktreePnpmInstallEnabled !== true) return

    const plan = await this.buildPnpmInstallPlan(target)
    if (!plan) return

    this.running.add(target.worktreePath)
    logger.log(`[deps] Starting pnpm install for worktree ${target.branchName} at ${target.worktreePath} using store ${plan.storeDir}`)

    let stdout = ''
    let stderr = ''
    const child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      env: { ...process.env, ...plan.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })

    const timer = setTimeout(() => {
      logger.warn(`[deps] pnpm install timed out for ${target.worktreePath}`)
      child.kill('SIGTERM')
    }, INSTALL_TIMEOUT_MS)

    child.stdout?.on('data', chunk => { stdout = trimOutput(stdout, chunk) })
    child.stderr?.on('data', chunk => { stderr = trimOutput(stderr, chunk) })
    child.on('error', err => {
      clearTimeout(timer)
      this.running.delete(target.worktreePath)
      logger.warn(`[deps] pnpm install failed to spawn for ${target.worktreePath}:`, err)
    })
    child.on('close', code => {
      clearTimeout(timer)
      this.running.delete(target.worktreePath)
      if (code === 0) {
        logger.log(`[deps] pnpm install completed for ${target.worktreePath} (pnpm ${plan.version})`)
        return
      }
      logger.warn(`[deps] pnpm install exited with code ${code} for ${target.worktreePath}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
    })
  }

  private async buildPnpmInstallPlan(target: WorktreeDependencyTarget): Promise<InstallPlan | null> {
    const lockfile = path.join(target.worktreePath, 'pnpm-lock.yaml')
    const packageJsonPath = path.join(target.worktreePath, 'package.json')
    if (!fs.existsSync(lockfile) || !fs.existsSync(packageJsonPath)) return null

    const packageJson = await this.readPackageJson(packageJsonPath)
    if (packageJson?.packageManager && !packageJson.packageManager.startsWith('pnpm@')) {
      logger.log(`[deps] Skipping pnpm install for ${target.worktreePath}; packageManager=${packageJson.packageManager}`)
      return null
    }

    const pnpm = await this.detectPnpm(target.worktreePath)
    if (!pnpm) {
      logger.warn(`[deps] Skipping pnpm install for ${target.worktreePath}; pnpm/corepack pnpm was not found`)
      return null
    }
    if (!isAtLeast(pnpm.version, MIN_GLOBAL_VIRTUAL_STORE_VERSION)) {
      logger.warn(`[deps] Skipping pnpm global virtual store for ${target.worktreePath}; pnpm ${pnpm.version} is older than 10.12.1`)
      return null
    }

    const storeDir = path.join(target.gitRoot, '.bat-cache', 'pnpm-store')
    await fsPromises.mkdir(storeDir, { recursive: true })
    await this.ensureGitExclude(target.gitRoot)

    const installArgs = [
      'install',
      '--frozen-lockfile',
      '--prefer-offline',
      '--store-dir',
      storeDir,
      '--config.enable-global-virtual-store=true',
    ]
    return {
      command: pnpm.command,
      args: [...pnpm.argsPrefix, ...installArgs],
      cwd: target.worktreePath,
      storeDir,
      version: pnpm.version,
      env: {
        npm_config_store_dir: storeDir,
        npm_config_enable_global_virtual_store: 'true',
      },
    }
  }

  private async detectPnpm(cwd: string): Promise<PnpmCommand | null> {
    const direct = await this.getCommandVersion('pnpm', ['--version'], cwd)
    if (direct) return { command: 'pnpm', argsPrefix: [], version: direct }
    const corepack = await this.getCommandVersion('corepack', ['pnpm', '--version'], cwd)
    if (corepack) return { command: 'corepack', argsPrefix: ['pnpm'], version: corepack }
    return null
  }

  private async getCommandVersion(command: string, args: string[], cwd: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(command, args, {
        cwd,
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      })
      return String(stdout).trim()
    } catch {
      return null
    }
  }

  private async readPackageJson(packageJsonPath: string): Promise<{ packageManager?: string } | null> {
    try {
      return JSON.parse(await fsPromises.readFile(packageJsonPath, 'utf8')) as { packageManager?: string }
    } catch {
      return null
    }
  }

  private async readSettings(): Promise<DependencySettings> {
    try {
      const settingsPath = path.join(getDataDir(), 'settings.json')
      return JSON.parse(await fsPromises.readFile(settingsPath, 'utf8')) as DependencySettings
    } catch {
      return {}
    }
  }

  private async ensureGitExclude(gitRoot: string): Promise<void> {
    const excludePath = path.join(gitRoot, '.git', 'info', 'exclude')
    try {
      const existing = await fsPromises.readFile(excludePath, 'utf8').catch(() => '')
      if (existing.split(/\r?\n/).some(line => line.trim() === '.bat-cache/')) return
      const prefix = existing.endsWith('\n') || existing.length === 0 ? '' : '\n'
      await fsPromises.appendFile(excludePath, `${prefix}.bat-cache/\n`, 'utf8')
    } catch (err) {
      logger.warn(`[deps] Failed to add .bat-cache/ to git exclude for ${gitRoot}:`, err)
    }
  }
}

export const dependencyManager = new DependencyManager()
