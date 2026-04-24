/**
 * Headless server entry — runs the RemoteServer without Electron.
 *
 * Usage:
 *   bat-server [--port=N] [--bind=localhost|tailscale|all]
 *              [--data-dir=PATH] [--token=HEX] [--debug]
 *
 * Environment variables (override defaults but lose to CLI flags):
 *   BAT_DATA_DIR, BAT_PORT, BAT_BIND, BAT_TOKEN, BAT_DEBUG
 *
 * Prints token + fingerprint + connect URL to stdout on startup so it can be
 * scraped from container logs. Handles SIGINT/SIGTERM with graceful shutdown.
 */

import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { setDataDir } from './server-core/data-dir'
import { setSafeStorage, plaintextSafeStorage } from './server-core/safe-storage'
import { setNotifier, noopNotifier } from './server-core/notifier'
import { logger } from './logger'
import { RemoteServer, type BindInterface } from './remote/remote-server'
import { PtyManager } from './pty-manager'
import { ClaudeAgentManager } from './claude-agent-manager'
import { CodexAgentManager } from './codex-agent-manager'
import { ProfileManager } from './profile-manager'
import { WindowRegistry } from './window-registry'
import { registerProxiedHandlers } from './server-core/register-handlers'

interface CliArgs {
  port: number
  bind: BindInterface
  dataDir: string
  token?: string
  help: boolean
}

function defaultDataDir(): string {
  if (process.env.BAT_DATA_DIR) return process.env.BAT_DATA_DIR
  // Mirror Electron's app.getPath('userData') layout per platform so a single
  // dataDir can be shared between desktop and headless modes.
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'better-agent-terminal')
  }
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    return path.join(base, 'better-agent-terminal')
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
  return path.join(xdg, 'better-agent-terminal')
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    port: Number(process.env.BAT_PORT) || 9876,
    bind: (process.env.BAT_BIND as BindInterface) || 'localhost',
    dataDir: defaultDataDir(),
    token: process.env.BAT_TOKEN,
    help: false,
  }
  for (const a of argv) {
    if (a === '--help' || a === '-h') { args.help = true; continue }
    const [key, ...rest] = a.split('=')
    const value = rest.join('=')
    switch (key) {
      case '--port': args.port = Number(value); break
      case '--bind': args.bind = value as BindInterface; break
      case '--data-dir': args.dataDir = value; break
      case '--token': args.token = value; break
      case '--debug': /* picked up by logger via process.argv */ break
      default:
        if (a.startsWith('--')) {
          console.error(`Unknown flag: ${a}`)
        }
    }
  }
  if (!Number.isFinite(args.port) || args.port <= 0 || args.port > 65535) {
    throw new Error(`Invalid --port: ${args.port}`)
  }
  if (!['localhost', 'tailscale', 'all'].includes(args.bind)) {
    throw new Error(`Invalid --bind: ${args.bind} (expected localhost|tailscale|all)`)
  }
  return args
}

function printHelp(): void {
  process.stdout.write(`bat-server — headless RemoteServer for better-agent-terminal

Usage:
  bat-server [options]

Options:
  --port=N            TCP port to listen on (default: 9876)
  --bind=IFACE        localhost | tailscale | all (default: localhost)
  --data-dir=PATH     persistent state directory
  --token=HEX         pin a known token (default: persisted or random)
  --debug             write debug.log inside data-dir
  -h, --help          show this help

Environment variables: BAT_DATA_DIR BAT_PORT BAT_BIND BAT_TOKEN BAT_DEBUG
`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { printHelp(); return }

  fs.mkdirSync(args.dataDir, { recursive: true })

  // Wire providers — must run before any module reads getDataDir() etc.
  setDataDir(args.dataDir)
  setSafeStorage(plaintextSafeStorage)
  setNotifier(noopNotifier)
  logger.init(args.dataDir)

  const ptyManager = new PtyManager(() => [])
  const claudeManager = new ClaudeAgentManager(() => [])
  const codexManager = new CodexAgentManager(() => [])
  const sessionManagerMap = new Map<string, 'claude' | 'codex' | 'openai'>()
  const windowRegistry = new WindowRegistry()
  const profileManager = new ProfileManager()
  profileManager.setWindowRegistry(windowRegistry)

  await windowRegistry.ensureInitialized()

  registerProxiedHandlers({
    getPtyManager: () => ptyManager,
    getClaudeManager: () => claudeManager,
    getCodexManager: () => codexManager,
    getOpenAIManager: () => null,
    sessionManagerMap,
    windowRegistry,
    profileManager,
  })

  const server = new RemoteServer()
  server.configDir = args.dataDir
  const result = await server.start({
    port: args.port,
    bindInterface: args.bind,
    token: args.token,
  })

  // Stdout banner — kept stable so containers / log scrapers can parse it.
  // `connect` is the one-shot URL: paste it into a profile's "Connection URL"
  // field to auto-fill host/port/token/fingerprint.
  const connectUrl = `wss://${result.boundHost}:${result.port}` +
    `?token=${encodeURIComponent(result.token)}&fp=${encodeURIComponent(result.fingerprint)}`
  process.stdout.write(`\nbat-server ready\n`)
  process.stdout.write(`  url:         wss://${result.boundHost}:${result.port}\n`)
  process.stdout.write(`  bind:        ${result.bindInterface}\n`)
  process.stdout.write(`  token:       ${result.token}\n`)
  process.stdout.write(`  fingerprint: ${result.fingerprint}\n`)
  process.stdout.write(`  data-dir:    ${args.dataDir}\n`)
  process.stdout.write(`  connect:     ${connectUrl}\n\n`)

  const shutdown = (signal: string) => {
    process.stdout.write(`\nReceived ${signal}, shutting down...\n`)
    try { server.stop() } catch (e) { logger.error('[shutdown] server.stop failed:', e) }
    setTimeout(() => process.exit(0), 250)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') return
    logger.error('[server-cli] uncaughtException:', err)
  })
  process.on('unhandledRejection', (reason) => {
    logger.error('[server-cli] unhandledRejection:', reason)
  })
}

main().catch(err => {
  process.stderr.write(`bat-server failed to start: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
