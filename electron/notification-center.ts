import { EventEmitter } from 'events'
import path from 'path'

export interface NotificationEntry {
  id: string
  sessionId: string
  windowId: string | null
  profileId: string | null
  workspaceName: string
  cwd: string
  reason: 'completed' | 'error' | 'aborted'
  result?: string
  error?: string
  timestamp: number
  read: boolean
  agentKind?: 'claude' | 'codex' | 'openai'
}

const MAX_ENTRIES = 50

class NotificationCenter extends EventEmitter {
  private entries: NotificationEntry[] = []
  private windowResolver: ((profileId: string | null) => string | null) | null = null

  /** Set how to resolve a profileId to the windowId that owns it. Called per-add. */
  setWindowResolver(fn: (profileId: string | null) => string | null): void {
    this.windowResolver = fn
  }

  add(input: {
    sessionId: string
    windowId?: string | null
    profileId: string | null
    cwd: string
    reason: 'completed' | 'error' | 'aborted'
    result?: string
    error?: string
    agentKind?: 'claude' | 'codex' | 'openai'
  }): NotificationEntry {
    const resolvedWindowId = input.windowId ?? this.windowResolver?.(input.profileId) ?? null
    const entry: NotificationEntry = {
      id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: input.sessionId,
      windowId: resolvedWindowId,
      profileId: input.profileId,
      workspaceName: path.basename(input.cwd) || input.cwd,
      cwd: input.cwd,
      reason: input.reason,
      result: input.result,
      error: input.error,
      timestamp: Date.now(),
      read: false,
      agentKind: input.agentKind,
    }
    this.entries.unshift(entry)
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(0, MAX_ENTRIES)
    }
    this.emit('change', this.entries)
    return entry
  }

  list(): NotificationEntry[] {
    return this.entries.slice()
  }

  unreadCount(): number {
    return this.entries.reduce((n, e) => (e.read ? n : n + 1), 0)
  }

  markRead(id: string): boolean {
    const entry = this.entries.find(e => e.id === id)
    if (!entry || entry.read) return false
    entry.read = true
    this.emit('change', this.entries)
    return true
  }

  markAllRead(): void {
    let changed = false
    for (const e of this.entries) {
      if (!e.read) {
        e.read = true
        changed = true
      }
    }
    if (changed) this.emit('change', this.entries)
  }

  markWindowRead(windowId: string): void {
    let changed = false
    for (const e of this.entries) {
      if (!e.read && e.windowId === windowId) {
        e.read = true
        changed = true
      }
    }
    if (changed) this.emit('change', this.entries)
  }

  clear(): void {
    if (this.entries.length === 0) return
    this.entries = []
    this.emit('change', this.entries)
  }

  /** Find the most recent unread entry that has a non-null windowId. */
  getLatestUnread(): NotificationEntry | null {
    for (const e of this.entries) {
      if (!e.read && e.windowId) return e
    }
    return null
  }
}

export const notificationCenter = new NotificationCenter()
