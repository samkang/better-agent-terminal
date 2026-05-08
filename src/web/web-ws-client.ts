/**
 * Low-level WebSocket client for RemoteFrame protocol.
 *
 * - Authenticates with `{type:'auth', token, args:[label, {windowId}]}`.
 * - `invoke(channel, args)` returns a Promise resolved by matching `invoke-result`.
 * - `on(event, cb)` subscribes to `{type:'event', channel:event}` frames.
 *
 * Browser-only — uses native WebSocket. No Node imports.
 */

type FrameType = 'invoke' | 'invoke-result' | 'invoke-error' | 'event' | 'auth' | 'auth-result' | 'ping' | 'pong'

interface RemoteFrame {
  type: FrameType
  id: string
  channel?: string
  args?: unknown[]
  result?: unknown
  error?: string
  token?: string
}

interface PendingInvoke {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const INVOKE_TIMEOUT_MS = 30_000
const AUTH_TIMEOUT_MS = 6_000

export type ConnectionState = 'connecting' | 'open' | 'closed'

export class WebWsClient {
  private ws: WebSocket | null = null
  private pending = new Map<string, PendingInvoke>()
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  private stateListeners = new Set<(state: ConnectionState) => void>()
  private _state: ConnectionState = 'closed'
  private idCounter = 0

  get state(): ConnectionState { return this._state }

  private setState(s: ConnectionState) {
    this._state = s
    for (const cb of this.stateListeners) cb(s)
  }

  onState(cb: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(cb)
    return () => this.stateListeners.delete(cb)
  }

  private nextId(): string {
    this.idCounter++
    return `${Date.now().toString(36)}-${this.idCounter}`
  }

  /** Connect + authenticate. Resolves on auth success, rejects on any failure. */
  async connect(url: string, token: string, label = 'web-client'): Promise<void> {
    this.setState('connecting')
    const ws = new WebSocket(url)
    this.ws = ws

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.removeEventListener('error', onErr)
        resolve()
      }
      const onErr = () => {
        ws.removeEventListener('open', onOpen)
        reject(new Error('WebSocket failed to open'))
      }
      ws.addEventListener('open', onOpen, { once: true })
      ws.addEventListener('error', onErr, { once: true })
    })

    ws.addEventListener('message', (ev) => this.onMessage(ev.data))
    ws.addEventListener('close', () => {
      this.setState('closed')
      const err = new Error('WebSocket closed')
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(err)
      }
      this.pending.clear()
    })

    // Auth handshake
    const authId = this.nextId()
    const authPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(authId)
        reject(new Error('Auth timeout'))
      }, AUTH_TIMEOUT_MS)
      this.pending.set(authId, {
        resolve: () => resolve(),
        reject,
        timer,
      })
    })
    this.send({
      type: 'auth',
      id: authId,
      token,
      args: [label, { windowId: null }],
    })
    await authPromise
    this.setState('open')
  }

  private send(frame: RemoteFrame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not open')
    }
    this.ws.send(JSON.stringify(frame))
  }

  private onMessage(raw: unknown): void {
    let frame: RemoteFrame
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      return
    }

    if (frame.type === 'auth-result') {
      const p = this.pending.get(frame.id)
      if (!p) return
      this.pending.delete(frame.id)
      clearTimeout(p.timer)
      if (frame.error) p.reject(new Error(frame.error))
      else p.resolve(frame.result)
      return
    }

    if (frame.type === 'invoke-result') {
      const p = this.pending.get(frame.id)
      if (!p) return
      this.pending.delete(frame.id)
      clearTimeout(p.timer)
      p.resolve(frame.result)
      return
    }

    if (frame.type === 'invoke-error') {
      const p = this.pending.get(frame.id)
      if (!p) return
      this.pending.delete(frame.id)
      clearTimeout(p.timer)
      p.reject(new Error(frame.error || 'Invoke failed'))
      return
    }

    if (frame.type === 'event' && frame.channel) {
      const set = this.listeners.get(frame.channel)
      if (!set) return
      const args = frame.args || []
      for (const cb of set) {
        try { cb(...args) } catch (e) { console.error('[ws] listener threw', e) }
      }
      return
    }

    if (frame.type === 'ping') {
      this.send({ type: 'pong', id: frame.id })
      return
    }
  }

  invoke(channel: string, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId()
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Invoke timeout: ${channel}`))
      }, INVOKE_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ type: 'invoke', id, channel, args })
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e as Error)
      }
    })
  }

  on(event: string, cb: (...args: unknown[]) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(cb)
    return () => {
      const s = this.listeners.get(event)
      if (!s) return
      s.delete(cb)
      if (s.size === 0) this.listeners.delete(event)
    }
  }

  close(): void {
    if (this.ws) {
      try { this.ws.close() } catch { /* ignore */ }
      this.ws = null
    }
    this.setState('closed')
  }
}
