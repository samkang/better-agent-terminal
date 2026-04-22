import { promises as fs } from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { ClaudeMessage, ClaudeToolCall } from '../../src/types/claude-agent'

export type HistoryItem = ClaudeMessage | ClaudeToolCall

export interface SessionSummary {
  sdkSessionId: string
  timestamp: number
  preview: string
  messageCount: number
}

function sessionsRoot(): string {
  return path.join(os.homedir(), '.better-agent-terminal', 'openai-sessions')
}

function dayDir(): string {
  const d = new Date()
  const yyyy = String(d.getFullYear())
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return path.join(sessionsRoot(), yyyy, mm, dd)
}

export function sessionFilePath(sdkSessionId: string, createdAtMs: number): string {
  const d = new Date(createdAtMs)
  const yyyy = String(d.getFullYear())
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return path.join(sessionsRoot(), yyyy, mm, dd, `${sdkSessionId}.jsonl`)
}

export async function ensureDayDir(): Promise<string> {
  const dir = dayDir()
  await fs.mkdir(dir, { recursive: true })
  return dir
}

export async function appendEvent(file: string, event: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, JSON.stringify({ ts: Date.now(), ...event }) + '\n', 'utf8')
}

export async function findSessionFile(sdkSessionId: string): Promise<string | null> {
  const root = sessionsRoot()
  try {
    const years = await fs.readdir(root, { withFileTypes: true })
    for (const y of years.filter(e => e.isDirectory())) {
      const yp = path.join(root, y.name)
      const months = await fs.readdir(yp, { withFileTypes: true })
      for (const m of months.filter(e => e.isDirectory())) {
        const mp = path.join(yp, m.name)
        const days = await fs.readdir(mp, { withFileTypes: true })
        for (const dd of days.filter(e => e.isDirectory())) {
          const candidate = path.join(mp, dd.name, `${sdkSessionId}.jsonl`)
          try {
            await fs.access(candidate)
            return candidate
          } catch { /* not here */ }
        }
      }
    }
  } catch { /* empty */ }
  return null
}

export async function loadHistory(file: string, sessionId: string): Promise<HistoryItem[]> {
  const content = await fs.readFile(file, 'utf8').catch(() => '')
  if (!content) return []
  const items: HistoryItem[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as { type?: string; payload?: Record<string, unknown>; ts?: number }
      const ts = typeof entry.ts === 'number' ? entry.ts : Date.now()
      if (entry.type === 'user' && entry.payload) {
        items.push({ id: `hist-u-${items.length}`, sessionId, role: 'user', content: String(entry.payload.content || ''), timestamp: ts })
      } else if (entry.type === 'assistant' && entry.payload) {
        items.push({ id: `hist-a-${items.length}`, sessionId, role: 'assistant', content: String(entry.payload.content || ''), thinking: entry.payload.thinking ? String(entry.payload.thinking) : undefined, timestamp: ts })
      } else if (entry.type === 'tool' && entry.payload) {
        const p = entry.payload
        items.push({
          id: String(p.id || `hist-t-${items.length}`),
          sessionId,
          toolName: String(p.toolName || 'tool'),
          input: (p.input as Record<string, unknown>) || {},
          status: (p.status as 'running' | 'completed' | 'error') || 'completed',
          result: p.result ? String(p.result) : undefined,
          timestamp: ts,
        })
      }
    } catch { /* skip */ }
  }
  return items
}

export async function listAllSessions(): Promise<SessionSummary[]> {
  const root = sessionsRoot()
  const results: SessionSummary[] = []
  try {
    const years = await fs.readdir(root, { withFileTypes: true })
    for (const y of years.filter(e => e.isDirectory())) {
      const yp = path.join(root, y.name)
      const months = await fs.readdir(yp, { withFileTypes: true })
      for (const m of months.filter(e => e.isDirectory())) {
        const mp = path.join(yp, m.name)
        const days = await fs.readdir(mp, { withFileTypes: true })
        for (const dd of days.filter(e => e.isDirectory())) {
          const dp = path.join(mp, dd.name)
          const files = await fs.readdir(dp, { withFileTypes: true })
          for (const f of files.filter(e => e.isFile() && e.name.endsWith('.jsonl'))) {
            const full = path.join(dp, f.name)
            const id = f.name.replace(/\.jsonl$/, '')
            try {
              const stat = await fs.stat(full)
              const content = await fs.readFile(full, 'utf8').catch(() => '')
              let preview = ''
              let count = 0
              for (const line of content.split('\n')) {
                if (!line.trim()) continue
                count++
                if (!preview) {
                  try {
                    const entry = JSON.parse(line) as { type?: string; payload?: { content?: string } }
                    if (entry.type === 'user' && entry.payload?.content) {
                      preview = String(entry.payload.content).split('\n')[0].slice(0, 120)
                    }
                  } catch { /* skip */ }
                }
              }
              results.push({ sdkSessionId: id, timestamp: stat.mtimeMs, preview: preview || `(${id.slice(0, 8)}...)`, messageCount: count })
            } catch { /* skip */ }
          }
        }
      }
    }
  } catch { /* empty */ }
  return results.sort((a, b) => b.timestamp - a.timestamp).slice(0, 50)
}

export function newSessionId(): string {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const rand = Math.random().toString(36).slice(2, 10)
  return `${yyyy}${mm}${dd}-${rand}`
}
