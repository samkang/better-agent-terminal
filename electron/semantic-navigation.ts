import { execFileSync } from 'child_process'
import * as fsSync from 'fs'
import * as path from 'path'
import { logger } from './logger'
import { getDataDir } from './server-core/data-dir'
import { applyBundledToolEnvironment } from './bundled-tools'

interface SemanticNavigationSettings {
  cxSemanticNavigationEnabled?: boolean
  cxBinaryPath?: string
}

export interface CxDetectionResult {
  enabled: boolean
  detected: boolean
  path?: string
  version?: string
  cacheDir: string
  error?: string
}

function readSettings(): SemanticNavigationSettings {
  try {
    const settingsPath = path.join(getDataDir(), 'settings.json')
    return JSON.parse(fsSync.readFileSync(settingsPath, 'utf-8')) as SemanticNavigationSettings
  } catch {
    return {}
  }
}

function splitFirstLine(value: string): string | undefined {
  return value.split(/\r?\n/).map(line => line.trim()).find(Boolean)
}

function resolveFromPath(): string | undefined {
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which'
    const lookup = execFileSync(command, ['cx'], { encoding: 'utf-8', timeout: 2000, windowsHide: true })
    return splitFirstLine(lookup)
  } catch {
    return undefined
  }
}

function resolveConfiguredPath(configuredPath: string | undefined): string | undefined {
  const trimmed = configuredPath?.trim()
  if (!trimmed) return resolveFromPath()

  if (path.isAbsolute(trimmed)) return trimmed
  if (trimmed.includes('/') || trimmed.includes('\\')) return path.resolve(trimmed)
  return trimmed
}

function cxCommandForPrompt(binaryPath: string): string {
  if (!/\s/.test(binaryPath)) return binaryPath
  return `"${binaryPath.replace(/"/g, '\\"')}"`
}

function runCxVersion(binaryPath: string): string {
  const output = execFileSync(binaryPath, ['--version'], {
    encoding: 'utf-8',
    timeout: 3000,
    windowsHide: true,
  }).trim()
  return output || 'cx'
}

export function detectCx(options?: { skipLookupWhenDisabled?: boolean }): CxDetectionResult {
  const settings = readSettings()
  const cacheDir = path.join(getDataDir(), 'cx-cache')
  const enabled = settings.cxSemanticNavigationEnabled === true

  if (!enabled && options?.skipLookupWhenDisabled) {
    return {
      enabled,
      detected: false,
      cacheDir,
      error: 'cx semantic navigation is disabled',
    }
  }

  const binaryPath = resolveConfiguredPath(settings.cxBinaryPath)

  if (!binaryPath) {
    return {
      enabled,
      detected: false,
      cacheDir,
      error: 'cx not found in PATH',
    }
  }

  try {
    const version = runCxVersion(binaryPath)
    return {
      enabled,
      detected: true,
      path: binaryPath,
      version,
      cacheDir,
    }
  } catch (err) {
    return {
      enabled,
      detected: false,
      path: binaryPath,
      cacheDir,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export function applyCxEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const toolEnv = applyBundledToolEnvironment(env)
  const cx = detectCx({ skipLookupWhenDisabled: true })
  if (!cx.enabled || !cx.detected) return toolEnv

  try {
    fsSync.mkdirSync(cx.cacheDir, { recursive: true })
  } catch (err) {
    logger.warn('[cx] Failed to create cache dir:', err)
  }

  return {
    ...toolEnv,
    CX_CACHE_DIR: cx.cacheDir,
  }
}

export function buildCxSystemPromptAppend(): string {
  const cx = detectCx({ skipLookupWhenDisabled: true })
  if (!cx.enabled || !cx.detected || !cx.path) return ''

  const cmd = cxCommandForPrompt(cx.path)
  return [
    'Semantic code navigation is available via cx.',
    'Prefer cx before reading large files:',
    `- ${cmd} overview PATH`,
    `- ${cmd} symbols --name GLOB --kind KIND`,
    `- ${cmd} definition --name NAME --from PATH`,
    `- ${cmd} references --name NAME --unique`,
    'Read full files only when cx output is insufficient.',
  ].join('\n')
}
