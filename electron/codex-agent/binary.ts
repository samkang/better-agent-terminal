import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { createRequire } from 'module'
import * as path from 'path'

export function getCodexInstallHint(): string {
  if (process.platform === 'darwin') {
    return 'brew install codex'
  }
  if (process.platform === 'win32') {
    return 'winget install OpenAI.Codex (or npm i -g @openai/codex)'
  }
  return 'brew install codex (see https://github.com/openai/codex for other install options)'
}

// Resolve to the bundled Codex native binary. The top-level @openai/codex
// wrapper ships JS/shell shims that cannot always be spawned directly.
function codexTargetTriple(): string | undefined {
  const { platform, arch } = process
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-musl'
  if (platform === 'linux' && arch === 'arm64') return 'aarch64-unknown-linux-musl'
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin'
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin'
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc'
  if (platform === 'win32' && arch === 'arm64') return 'aarch64-pc-windows-msvc'
  return undefined
}

function findCodexOnPath(): string | undefined {
  try {
    const command = process.platform === 'win32'
      ? 'where.exe codex'
      : 'command -v codex || which codex'
    const result = execSync(command, { encoding: 'utf-8', timeout: 3000 }).trim()
    if (!result) return undefined
    const candidates = result.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    for (const candidate of candidates) {
      if (/\.(cmd|bat|ps1)$/i.test(candidate)) continue
      if (/[\\/]node_modules[\\/]\.bin[\\/]/i.test(candidate)) continue
      if (process.platform === 'win32' && !/\.exe$/i.test(candidate)) continue
      return candidate
    }
    return undefined
  } catch {
    return undefined
  }
}

function findBundledCodex(): string | undefined {
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex'
  const triple = codexTargetTriple()
  if (!triple) return undefined
  const platformPkg = `@openai/codex-${process.platform}-${process.arch}`
  try {
    const req = createRequire(import.meta.url ?? __filename)
    let pkgJson = req.resolve(`${platformPkg}/package.json`)
    if (pkgJson.includes('app.asar') && !pkgJson.includes('app.asar.unpacked')) {
      pkgJson = pkgJson.replace('app.asar', 'app.asar.unpacked')
    }
    const candidate = path.join(path.dirname(pkgJson), 'vendor', triple, 'codex', exe)
    if (existsSync(candidate)) return candidate
  } catch {
    // Platform package not installed; fall through.
  }
  return undefined
}

export function findCodexBinary(): string | undefined {
  const override = process.env.BAT_CODEX_BIN
  if (override && existsSync(override)) return override

  const onPath = findCodexOnPath()
  if (onPath) return onPath

  return findBundledCodex()
}
