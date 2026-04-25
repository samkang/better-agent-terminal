import { existsSync, promises as fs } from 'fs'
import os from 'os'
import * as path from 'path'
import { logger } from '../logger'
import { getDataDir, isDataDirSet } from '../server-core/data-dir'

interface CacheEntry {
  logPath: string
  // YYYY/MM/DD parts of the log path under ~/.codex/sessions, kept so we can
  // start a focused walk (same date or neighbouring days) when the cached
  // path is invalidated.
  year?: string
  month?: string
  day?: string
  ts: number
}

interface CacheFile {
  v: 1
  entries: Record<string, CacheEntry>
}

const CACHE_VERSION = 1
const CACHE_FILENAME = 'codex-thread-log-cache.json'

let cache: Map<string, CacheEntry> | null = null
let loading: Promise<void> | null = null
let pendingWrite: Promise<void> | null = null
let dirty = false

function cachePath(): string | null {
  if (!isDataDirSet()) return null
  return path.join(getDataDir(), CACHE_FILENAME)
}

function getCodexSessionsRoot(): string {
  return path.join(os.homedir(), '.codex', 'sessions')
}

function extractDateParts(logPath: string): { year?: string; month?: string; day?: string } {
  const root = getCodexSessionsRoot()
  if (!logPath.startsWith(root)) return {}
  const rel = logPath.slice(root.length).replace(/^[\\/]/, '')
  const parts = rel.split(/[\\/]/)
  if (parts.length < 4) return {}
  return { year: parts[0], month: parts[1], day: parts[2] }
}

async function ensureLoaded(): Promise<void> {
  if (cache) return
  if (loading) return loading
  loading = (async () => {
    cache = new Map()
    const p = cachePath()
    if (!p) return
    try {
      const raw = await fs.readFile(p, 'utf8')
      const parsed = JSON.parse(raw) as CacheFile
      if (parsed?.v === CACHE_VERSION && parsed.entries) {
        for (const [threadId, entry] of Object.entries(parsed.entries)) {
          if (entry?.logPath) cache!.set(threadId, entry)
        }
      }
    } catch {
      // No cache yet (first run) or corrupted — start fresh.
    }
  })()
  try {
    await loading
  } finally {
    loading = null
  }
}

async function flush(): Promise<void> {
  if (!dirty || !cache) return
  const p = cachePath()
  if (!p) return
  dirty = false
  const file: CacheFile = {
    v: CACHE_VERSION,
    entries: Object.fromEntries(cache.entries()),
  }
  const tmp = `${p}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(file), 'utf8')
    await fs.rename(tmp, p)
  } catch (err) {
    logger.error('[codex-log-cache] Failed to persist cache:', err)
  }
}

function scheduleFlush(): void {
  if (pendingWrite) return
  pendingWrite = new Promise(resolve => {
    setTimeout(async () => {
      try {
        await flush()
      } finally {
        pendingWrite = null
        resolve()
      }
    }, 250)
  })
}

export async function getCachedLogPath(threadId: string): Promise<string | null> {
  await ensureLoaded()
  const entry = cache!.get(threadId)
  if (!entry) return null
  if (!existsSync(entry.logPath)) {
    cache!.delete(threadId)
    dirty = true
    scheduleFlush()
    return null
  }
  return entry.logPath
}

export async function getCachedDateHint(threadId: string): Promise<{ year?: string; month?: string; day?: string } | null> {
  await ensureLoaded()
  const entry = cache!.get(threadId)
  if (!entry) return null
  return { year: entry.year, month: entry.month, day: entry.day }
}

export async function setCachedLogPath(threadId: string, logPath: string): Promise<void> {
  await ensureLoaded()
  const dateParts = extractDateParts(logPath)
  cache!.set(threadId, {
    logPath,
    ...dateParts,
    ts: Date.now(),
  })
  dirty = true
  scheduleFlush()
}

export async function removeCachedLogPath(threadId: string): Promise<void> {
  await ensureLoaded()
  if (cache!.delete(threadId)) {
    dirty = true
    scheduleFlush()
  }
}
