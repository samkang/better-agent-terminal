import * as fs from 'fs'
import * as path from 'path'

let cachedRipgrepPath: string | null | undefined

function executableName(base: string): string {
  return process.platform === 'win32' ? `${base}.exe` : base
}

function asarUnpackedPath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined
  return filePath.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}

function existingFile(candidates: Array<string | undefined>): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    } catch {
      // Keep looking.
    }
  }
  return null
}

export function resolveBundledRipgrepPath(): string | null {
  if (cachedRipgrepPath !== undefined) return cachedRipgrepPath

  let moduleRgPath: string | undefined
  try {
    moduleRgPath = (require('@vscode/ripgrep') as { rgPath?: string }).rgPath
  } catch {
    moduleRgPath = undefined
  }

  const rgName = executableName('rg')
  cachedRipgrepPath = existingFile([
    asarUnpackedPath(moduleRgPath),
    moduleRgPath,
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules', '@vscode', 'ripgrep', 'bin', rgName),
    path.join(__dirname, '..', 'node_modules', '@vscode', 'ripgrep', 'bin', rgName),
    path.join(process.cwd(), 'node_modules', '@vscode', 'ripgrep', 'bin', rgName),
  ])

  return cachedRipgrepPath
}

function pathEnvKey(env: NodeJS.ProcessEnv): string {
  if (process.platform !== 'win32') return 'PATH'
  return Object.keys(env).find(key => key.toLowerCase() === 'path') || 'Path'
}

function prependPath(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const key = pathEnvKey(env)
  const current = env[key] || ''
  const entries = current.split(path.delimiter).filter(Boolean)
  const hasDir = entries.some(entry =>
    process.platform === 'win32'
      ? entry.toLowerCase() === dir.toLowerCase()
      : entry === dir
  )

  return {
    ...env,
    [key]: hasDir ? current : [dir, current].filter(Boolean).join(path.delimiter),
  }
}

export function applyBundledToolEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const rgPath = resolveBundledRipgrepPath()
  if (!rgPath) return env

  return {
    ...prependPath(env, path.dirname(rgPath)),
    BAT_RIPGREP_PATH: rgPath,
  }
}
