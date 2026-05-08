# Web Interface v0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing React renderer runnable from a real browser tab against a `bat-server`, with Claude session and Terminal both functional.

**Architecture:** A new web entry point (`src/web/main-web.tsx`) opens a WebSocket to `bat-server`, performs the existing token auth, then installs a `Proxy`-based shim at `window.electronAPI` that translates property-access + method calls into `RemoteFrame` invokes/events. The unmodified `<App>` then renders. A second Vite config builds/serves this entry separately from the Electron build, with a dev proxy that bypasses the self-signed TLS cert.

**Tech Stack:** Vite, React 18, browser `WebSocket`, TypeScript. No new runtime dependencies — all infra (RemoteFrame protocol, `bat-server`, `RemoteServer`) already exists.

**Reference:** spec at `docs/superpowers/specs/2026-05-08-web-interface-v0-design.md`.

**Conventions:**
- Use **pnpm** (per `CLAUDE.md`). Never `npm`/`npx`.
- Use logger or `console.log` only inside `src/web/` (no `window.electronAPI.debug.log` until bridge installed).
- Commit per task. Don't break existing Electron build — verify with `pnpm exec tsc --noEmit --pretty false` after each task.

---

## File Structure

| Path | Purpose |
|---|---|
| `index.web.html` (new, root) | Entry HTML for browser, loads `src/web/main-web.tsx` |
| `vite.config.web.ts` (new, root) | Vite config for web build/dev, no Electron plugins, ws proxy |
| `src/web/channel-name.ts` (new) | Pure utility: namespace.method → IPC channel name |
| `src/web/web-ws-client.ts` (new) | Low-level WebSocket + RemoteFrame protocol (auth, invoke, events) |
| `src/web/web-api-bridge.ts` (new) | Proxy that exposes `electronAPI` shape, delegates to ws-client |
| `src/web/stubs.ts` (new) | Electron-only API stubs (`shell`, `dialog`, `image`, `clipboard`, `app`) |
| `src/web/main-web.tsx` (new) | Web entry: connect, install bridge, render `<App>` |
| `tests/web-channel-name.test.ts` (new) | Unit test for channel-name utility |
| `package.json` (modify, line ~12) | Add `dev:web` script |

**Untouched:** `electron/`, existing `vite.config.ts`, `src/App.tsx`, all existing components, `bin/bat-server.js`.

---

## Task 1: Project Skeleton — HTML, Vite Config, Script

**Files:**
- Create: `index.web.html`
- Create: `vite.config.web.ts`
- Modify: `package.json`

- [ ] **Step 1: Create `index.web.html` at repo root**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Better Agent Terminal — Web</title>
    <style>
      body { margin: 0; background: #1a1a1a; overflow: hidden; }
      #boot {
        position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
        color: #888; font-family: system-ui; font-size: 13px;
      }
    </style>
  </head>
  <body>
    <div id="boot">Connecting…</div>
    <div id="root"></div>
    <script type="module" src="/src/web/main-web.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `vite.config.web.ts`**

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Web target — no Electron plugins, no electron-renderer.
// Dev proxy bypasses the self-signed TLS cert that bat-server uses.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist-web',
    rollupOptions: {
      input: path.resolve(__dirname, 'index.web.html'),
    },
  },
  server: {
    port: 5173,
    open: '/index.web.html',
    proxy: {
      // Browser opens ws://localhost:5173/ws → Vite forwards to wss://localhost:9876
      // with TLS verification disabled (self-signed cert).
      '/ws': {
        target: 'wss://localhost:9876',
        ws: true,
        secure: false,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ws/, ''),
      },
    },
  },
})
```

- [ ] **Step 3: Add `dev:web` script in `package.json`**

Edit `package.json` and insert after the existing `"dev"` script (around line 12):

```json
    "dev:web": "vite --config vite.config.web.ts",
```

- [ ] **Step 4: Verify Electron build still compiles**

Run: `pnpm exec tsc --noEmit --pretty false`
Expected: No errors. (Web files don't exist yet, but TS shouldn't complain because nothing imports them.)

- [ ] **Step 5: Commit**

```bash
git add index.web.html vite.config.web.ts package.json
git commit -m "feat(web): add web target scaffolding (HTML, vite config, dev:web script)"
```

---

## Task 2: Channel Name Utility + Unit Test

The bridge needs to convert `electronAPI.pty.getCwd` calls to `pty:get-cwd` IPC channel names. Pure function — testable in isolation.

**Files:**
- Create: `src/web/channel-name.ts`
- Create: `tests/web-channel-name.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/web-channel-name.test.ts`:

```ts
/**
 * Run: pnpm exec tsx tests/web-channel-name.test.ts
 */
import * as assert from 'assert'
import { toChannelName } from '../src/web/channel-name'

let passed = 0, failed = 0
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${(e as Error).message}`) }
}

console.log('toChannelName')
test('namespace + camelCase method → kebab', () => {
  assert.strictEqual(toChannelName('pty', 'getCwd'), 'pty:get-cwd')
})
test('namespace + single-word method → unchanged method', () => {
  assert.strictEqual(toChannelName('pty', 'write'), 'pty:write')
})
test('namespace + multi-cap acronym method', () => {
  assert.strictEqual(toChannelName('claude', 'getCliPath'), 'claude:get-cli-path')
})
test('claude.startSession → claude:start-session', () => {
  assert.strictEqual(toChannelName('claude', 'startSession'), 'claude:start-session')
})
test('settings.detectCx → settings:detect-cx', () => {
  assert.strictEqual(toChannelName('settings', 'detectCx'), 'settings:detect-cx')
})
test('image.readAsDataUrl → image:read-as-data-url', () => {
  assert.strictEqual(toChannelName('image', 'readAsDataUrl'), 'image:read-as-data-url')
})
test('snippet.getAll preserves all-lower → snippet:getAll? no, kebab', () => {
  // existing channel is 'snippet:getAll' (camelCase preserved). The codebase is
  // inconsistent. We choose: ALWAYS kebab. Document the exceptions in stubs.ts
  // if they break.
  assert.strictEqual(toChannelName('snippet', 'getAll'), 'snippet:get-all')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx tests/web-channel-name.test.ts`
Expected: FAIL — `Cannot find module '../src/web/channel-name'`

- [ ] **Step 3: Implement `src/web/channel-name.ts`**

```ts
/**
 * Convert an `electronAPI.<namespace>.<method>` call into the IPC channel name
 * used by the host (e.g. `pty.getCwd` → `pty:get-cwd`).
 *
 * Rule: lowercase namespace, then ':', then method converted from camelCase to
 * kebab-case. Note: a few host channels in this codebase use camelCase
 * (`snippet:getAll`, `git:getRoot`). Those are listed as overrides in stubs.ts
 * if/when they break in practice.
 */
export function toChannelName(namespace: string, method: string): string {
  const kebab = method
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
  return `${namespace}:${kebab}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsx tests/web-channel-name.test.ts`
Expected: All 7 tests PASS, exit 0.

- [ ] **Step 5: Verify TS still compiles**

Run: `pnpm exec tsc --noEmit --pretty false`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/web/channel-name.ts tests/web-channel-name.test.ts
git commit -m "feat(web): add channel-name kebab conversion utility + tests"
```

---

## Task 3: Channel Name Override Map (camelCase exceptions)

Some IPC channels in the existing codebase don't follow kebab convention (e.g. `snippet:getAll`, `git:getRoot`, `app:get-window-id` already kebab but `git:getRoot` is camelCase). We need an override map that the bridge consults before falling back to `toChannelName`.

**Files:**
- Modify: `src/web/channel-name.ts`
- Modify: `tests/web-channel-name.test.ts`

- [ ] **Step 1: Update test to cover override map**

Append to `tests/web-channel-name.test.ts` before the `console.log` summary:

```ts
console.log('\nresolveChannel (with overrides)')
test('snippet.getAll uses override → snippet:getAll', () => {
  assert.strictEqual(resolveChannel('snippet', 'getAll'), 'snippet:getAll')
})
test('git.getRoot uses override → git:getRoot', () => {
  assert.strictEqual(resolveChannel('git', 'getRoot'), 'git:getRoot')
})
test('pty.getCwd has no override → pty:get-cwd', () => {
  assert.strictEqual(resolveChannel('pty', 'getCwd'), 'pty:get-cwd')
})
```

And update the imports at the top:

```ts
import { toChannelName, resolveChannel } from '../src/web/channel-name'
```

- [ ] **Step 2: Run test to verify the new ones fail**

Run: `pnpm exec tsx tests/web-channel-name.test.ts`
Expected: 3 new tests FAIL — `resolveChannel is not a function`.

- [ ] **Step 3: Implement `resolveChannel` with override map**

Append to `src/web/channel-name.ts`:

```ts
/**
 * Channel name overrides — host uses camelCase or other non-kebab forms for
 * some channels. Look these up before falling back to toChannelName().
 *
 * Sourced from electron/preload.ts ipcRenderer.invoke() literals.
 */
const OVERRIDES: Record<string, string> = {
  'snippet.getAll': 'snippet:getAll',
  'snippet.getById': 'snippet:getById',
  'snippet.toggleFavorite': 'snippet:toggleFavorite',
  'snippet.getCategories': 'snippet:getCategories',
  'snippet.getFavorites': 'snippet:getFavorites',
  'snippet.getByWorkspace': 'snippet:getByWorkspace',
  'git.getRoot': 'git:getRoot',
  'fs.readFile': 'fs:readFile',
  'fs.readdir': 'fs:readdir',
  'workerBuffer.readAll': 'worker-buffer:readAll',
  'workerBuffer.init': 'worker-buffer:init',
  'workerBuffer.append': 'worker-buffer:append',
  'workerBuffer.clear': 'worker-buffer:clear',
}

export function resolveChannel(namespace: string, method: string): string {
  const key = `${namespace}.${method}`
  return OVERRIDES[key] ?? toChannelName(namespace, method)
}
```

- [ ] **Step 4: Run test to verify all pass**

Run: `pnpm exec tsx tests/web-channel-name.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/channel-name.ts tests/web-channel-name.test.ts
git commit -m "feat(web): add resolveChannel with override map for camelCase channels"
```

---

## Task 4: WebSocket Client — RemoteFrame Protocol

Low-level WebSocket wrapper. Owns connection state, frame encoding/decoding, auth handshake, invoke promises, event subscriptions.

**Files:**
- Create: `src/web/web-ws-client.ts`

- [ ] **Step 1: Write `web-ws-client.ts`**

```ts
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
```

- [ ] **Step 2: Verify TS compiles**

Run: `pnpm exec tsc --noEmit --pretty false`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/web/web-ws-client.ts
git commit -m "feat(web): add low-level WebSocket client with RemoteFrame protocol"
```

---

## Task 5: Electron-only API Stubs

Stubs for APIs that can't be remoted (browser-native or no-op). Used by the bridge.

**Files:**
- Create: `src/web/stubs.ts`

- [ ] **Step 1: Write `src/web/stubs.ts`**

```ts
/**
 * Stubs for Electron-only APIs that cannot be proxied over WebSocket.
 * Some are mapped to browser-native equivalents; others log a warning and
 * return a safe default.
 */

function warn(name: string): void {
  console.warn(`[web] ${name} is not available in browser; returning stub value`)
}

export const shellStubs = {
  openExternal: (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer')
    return Promise.resolve()
  },
  openPath: (folderPath: string) => {
    warn(`shell.openPath(${folderPath})`)
    return Promise.resolve()
  },
  getPathForFile: (_file: File) => '', // Electron-only API; no equivalent
}

export const dialogStubs = {
  selectFolder: () => { warn('dialog.selectFolder'); return Promise.resolve(null) },
  selectImages: () => { warn('dialog.selectImages'); return Promise.resolve([]) },
  selectFiles: () => { warn('dialog.selectFiles'); return Promise.resolve([]) },
  confirm: (msg: string) => Promise.resolve(window.confirm(msg)),
}

export const imageStubs = {
  readAsDataUrl: (_filePath: string) => {
    warn('image.readAsDataUrl — use FileReader on browser File objects directly')
    return Promise.reject(new Error('Not available in web'))
  },
  saveDataUrl: (_dataUrl: string, _defaultName?: string) => {
    warn('image.saveDataUrl')
    return Promise.resolve(null)
  },
}

export const clipboardStubs = {
  saveImage: () => { warn('clipboard.saveImage'); return Promise.resolve(null) },
  writeImage: (_filePath: string) => { warn('clipboard.writeImage'); return Promise.resolve(false) },
  writeText: async (text: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (e) {
      console.warn('[web] clipboard.writeText failed:', e)
      return false
    }
  },
  onCopyShortcut: (_cb: () => void) => () => {}, // No-op unsubscriber
}

export const appStubs = {
  openNewInstance: (_id: string) => { warn('app.openNewInstance'); return Promise.resolve() },
  newWindow: () => { warn('app.newWindow'); return Promise.resolve('') },
  focusNextWindow: () => Promise.resolve(false),
  setDockBadge: (_n: number) => { /* no-op */ },
  // Window-identity stubs — return null so renderer treats this as "default" window
  getWindowId: () => Promise.resolve(null),
  getWindowProfile: () => Promise.resolve(null),
  getWindowIndex: () => Promise.resolve(0),
  getLaunchProfile: () => Promise.resolve(null),
}

export const updateStubs = {
  check: () => Promise.resolve(null),
  getVersion: () => Promise.resolve('web'),
}

export const debugStubs = {
  log: (...args: unknown[]) => console.log('[debug]', ...args),
  isDebugMode: false,
}

export const workspaceLocalStubs = {
  // window.location.search-derived; safe to compute in browser
  getDetachedId: () => new URLSearchParams(window.location.search).get('detached'),
}
```

- [ ] **Step 2: Verify TS compiles**

Run: `pnpm exec tsc --noEmit --pretty false`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/web/stubs.ts
git commit -m "feat(web): add browser stubs for Electron-only APIs"
```

---

## Task 6: API Bridge — Proxy + ws-client

The bridge: `Proxy` that intercepts `window.electronAPI.<ns>.<method>(...args)` and `<ns>.on<Event>(cb)`, routes to ws-client, splices in stubs for unproxiable APIs.

**Files:**
- Create: `src/web/web-api-bridge.ts`

- [ ] **Step 1: Write `src/web/web-api-bridge.ts`**

```ts
import { resolveChannel } from './channel-name'
import { WebWsClient } from './web-ws-client'
import {
  shellStubs, dialogStubs, imageStubs, clipboardStubs,
  appStubs, updateStubs, debugStubs, workspaceLocalStubs,
} from './stubs'

/**
 * Map of namespaces that are fully replaced by stubs (not proxied).
 * Other namespaces fall through to the dynamic Proxy.
 */
function buildStubNamespaces() {
  return {
    shell: shellStubs,
    dialog: dialogStubs,
    image: imageStubs,
    clipboard: clipboardStubs,
    update: updateStubs,
    debug: debugStubs,
  } as const
}

/**
 * Per-namespace partial overrides — a few methods are stubbed, the rest are
 * proxied. e.g. `app.getWindowId` is local, but real `app:*` channels exist.
 */
const PARTIAL_STUBS: Record<string, Record<string, unknown>> = {
  app: appStubs,
  workspace: workspaceLocalStubs,
}

/**
 * Map of method names that are event subscriptions (start with `on`) and
 * should NOT be invoked over WS — instead, they wire up a listener for the
 * matching event channel.
 *
 * `pty.onOutput(cb)` → ws.on('pty:output', cb)
 * `claude.onMessage(cb)` → ws.on('claude:message', cb)
 *
 * Method-name → event-channel rule: stripped 'on' prefix, lowercased,
 * then prefixed with namespace + ':'. `onToolUse` → `tool-use`.
 */
function eventChannelFor(namespace: string, method: string): string | null {
  if (!method.startsWith('on') || method.length < 3) return null
  // Trim 'on' and convert PascalCase → kebab-case
  const tail = method.slice(2)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
  return `${namespace}:${tail}`
}

/**
 * Build the bridge. Result has the same shape as `window.electronAPI`.
 */
export function buildBridge(ws: WebWsClient, platform: string): unknown {
  const stubs = buildStubNamespaces()

  const makeNamespace = (namespace: string) => {
    const partial = PARTIAL_STUBS[namespace] || {}
    return new Proxy({} as Record<string, unknown>, {
      get(_t, prop: string) {
        // Local override (in PARTIAL_STUBS)
        if (prop in partial) return partial[prop]

        // Event subscription? → return function that wires ws listener
        const eventChannel = eventChannelFor(namespace, prop)
        if (eventChannel) {
          return (cb: (...args: unknown[]) => void) => ws.on(eventChannel, cb)
        }

        // Default: dynamic invoke
        const channel = resolveChannel(namespace, prop)
        return (...args: unknown[]) => ws.invoke(channel, args)
      },
    })
  }

  const root: Record<string, unknown> = {
    platform,
    systemVersion: '',
    ...stubs,
  }

  // Proxy fallback for any namespace not explicitly stubbed
  return new Proxy(root, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      // Lazy-create namespace proxy on first access, cache it
      const ns = makeNamespace(prop)
      target[prop] = ns
      return ns
    },
  })
}
```

- [ ] **Step 2: Verify TS compiles**

Run: `pnpm exec tsc --noEmit --pretty false`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/web/web-api-bridge.ts
git commit -m "feat(web): add Proxy-based API bridge that translates electronAPI calls to WS"
```

---

## Task 7: Web Entry Point — main-web.tsx

Connects to bat-server, installs bridge, renders App. No reconnect UI for v0 (just reload).

**Files:**
- Create: `src/web/main-web.tsx`

- [ ] **Step 1: Write `src/web/main-web.tsx`**

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { WebWsClient } from './web-ws-client'
import { buildBridge } from './web-api-bridge'

// Detect host platform from URL ?platform= or fall back to 'win32' (the most
// common dev target). Renderer reads this for ConPTY / shortcut decisions.
function getPlatform(): string {
  const fromQuery = new URLSearchParams(window.location.search).get('platform')
  if (fromQuery) return fromQuery
  // Heuristic — may be wrong but harmless for v0.
  if (navigator.platform.toLowerCase().includes('mac')) return 'darwin'
  if (navigator.platform.toLowerCase().includes('linux')) return 'linux'
  return 'win32'
}

function showError(msg: string) {
  const el = document.getElementById('boot')
  if (el) {
    el.style.color = '#e88'
    el.style.padding = '20px'
    el.style.whiteSpace = 'pre-wrap'
    el.style.alignItems = 'flex-start'
    el.style.justifyContent = 'flex-start'
    el.textContent = msg
  }
}

async function boot() {
  const params = new URLSearchParams(window.location.search)
  const token = params.get('token')
  if (!token) {
    showError(
      'Missing token query parameter.\n\n' +
      'Start bat-server with `pnpm run start:server`, copy the token from its\n' +
      'startup output, and reload the page with ?token=<token>.\n' +
      '(Optional: ?platform=win32|darwin|linux to override host platform.)'
    )
    return
  }

  // Vite dev proxies /ws → wss://localhost:9876, bypassing the self-signed cert.
  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
  const ws = new WebWsClient()

  try {
    await ws.connect(wsUrl, token, 'web-browser')
  } catch (e) {
    showError(`Failed to connect: ${(e as Error).message}\n\nIs bat-server running?`)
    return
  }

  // Auto-reload on disconnect (v0 reconnect strategy)
  ws.onState((state) => {
    if (state === 'closed') {
      console.warn('[web] ws closed — reloading in 2s')
      setTimeout(() => location.reload(), 2000)
    }
  })

  // Install the bridge under window.electronAPI before importing App.
  const bridge = buildBridge(ws, getPlatform())
  ;(window as unknown as { electronAPI: unknown }).electronAPI = bridge

  // Dynamic import so App and its descendants only resolve `window.electronAPI`
  // after the bridge is installed.
  const { default: App } = await import('../App')
  await import('../i18n')
  await import('../styles/base.css')
  await import('../styles/layout.css')
  await import('../styles/panels.css')
  await import('../styles/settings.css')
  await import('../styles/context-menu.css')
  await import('../styles/notifications.css')
  await import('../styles/env-snippets.css')
  await import('../styles/resize.css')
  await import('../styles/file-browser.css')
  await import('../styles/path-linker.css')
  await import('../styles/prompt-box.css')
  await import('../styles/claude-agent.css')
  await import('../styles/skills-panel.css')

  const bootEl = document.getElementById('boot')
  if (bootEl) bootEl.remove()

  const root = document.getElementById('root')!
  ReactDOM.createRoot(root).render(<App />)
}

boot().catch((e) => {
  console.error('[web] boot failed', e)
  showError(`Boot failed: ${(e as Error).message}`)
})
```

- [ ] **Step 2: Verify TS compiles**

Run: `pnpm exec tsc --noEmit --pretty false`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/web/main-web.tsx
git commit -m "feat(web): add web entry point — connect, install bridge, render App"
```

---

## Task 8: Manual Verification

This is a prototype; acceptance is by manual exercise. The user is the tester.

**Files:** None modified.

- [ ] **Step 1: Start bat-server in a terminal**

```powershell
pnpm run start:server
```

Expected output includes:
- A line like `[RemoteServer] Started on wss://127.0.0.1:9876 (iface=localhost), fingerprint: ...`
- A token printed (16-byte hex). If not visible in output, look at `%APPDATA%\better-agent-terminal\server-token.enc.json` (encrypted) — easier to use option B below.

If the server doesn't print the token, stop it and restart with an explicit token via the env or option (note: bat-server CLI may not accept token override — fall back to reading server logs at the standard log path: `%APPDATA%\better-agent-terminal\debug.log`).

- [ ] **Step 2: Start web dev server in a second terminal**

```powershell
pnpm run dev:web
```

Expected: Vite prints `Local: http://localhost:5173/index.web.html` and opens browser.

- [ ] **Step 3: Append `?token=<token>` to the URL and reload**

Expected: "Connecting…" replaced by the full app UI. No console errors about `electronAPI undefined`.

- [ ] **Step 4: Smoke-test Claude session**

In the UI:
1. Create a new workspace pointing at any folder (e.g. `C:\Users\Sam\Documents`).
2. Open a Claude agent panel in that workspace.
3. Send a prompt like "list the files in this folder".
4. Watch streaming text appear.
5. Verify tool calls render with status (e.g. Glob/LS).

Expected: streaming works, tool calls render, no IPC-related errors in DevTools console.

- [ ] **Step 5: Smoke-test Terminal**

1. Open a terminal panel (real shell) in the same workspace.
2. Type `dir` (Windows) or `ls` (mac/linux), Enter.
3. Output appears.
4. Type a long-running command like `Get-ChildItem -Recurse C:\Users\Sam\Documents | Select-Object -First 50` to test 8ms output coalescing under load.
5. Resize the terminal panel — verify shell prompt re-renders correctly.

Expected: keystrokes echo, ANSI colors render, resize doesn't break layout.

- [ ] **Step 6: Disconnect/reconnect**

1. Stop bat-server (Ctrl+C in its terminal).
2. Browser shows console warning + 2s later auto-reloads.
3. Reload shows "Failed to connect" error.
4. Restart bat-server. Reload browser.
5. App boots cleanly.

Expected: graceful failure, reload recovers.

- [ ] **Step 7: Document findings + commit notes**

If smoke tests pass, no changes needed. If specific channels/methods break (e.g. a missing override), fix them in `src/web/channel-name.ts` overrides map and commit.

If everything works:

```bash
git log --oneline -10  # confirm clean history
```

If broken: gather the specific channel name + error in DevTools, add to override map or stubs.ts, commit fix, retest.

---

## Self-Review

**Spec coverage:**
- ✅ `web-api-bridge.ts` (Component 1) — Task 6
- ✅ `main-web.tsx` (Component 2) — Task 7
- ✅ `index.web.html` (Component 3) — Task 1
- ✅ `vite.config.web.ts` (Component 4) — Task 1
- ✅ `dev:web` script (Component 5) — Task 1
- ✅ Channel name derivation rule — Task 2
- ✅ Override map — Task 3 (added on top of spec, surfaced from real codebase inspection)
- ✅ Event subscription handling — Task 6 (`eventChannelFor`)
- ✅ Stubs for shell/dialog/image/clipboard/app — Task 5
- ✅ Reconnect strategy (auto-reload) — Task 7
- ✅ TLS bypass via Vite proxy — Task 1
- ✅ Manual acceptance criteria (5 items) — Task 8

**Placeholder scan:** none found. Every step has runnable code or concrete commands.

**Type consistency:** `WebWsClient.invoke/on/connect/onState/close` used in Task 6/7 match definitions in Task 4. `resolveChannel` used in Task 6 matches Task 3. `buildBridge(ws, platform)` signature in Task 6 matches usage in Task 7.

**Scope check:** Single coherent feature, ~7 source files + 1 test, all under `src/web/`. Tight enough for one implementation pass.

**Ambiguity check:**
- Task 8 step 1 acknowledges uncertainty about how bat-server prints the token. Provided the fallback (read log file). Acceptable for v0 manual flow.
- Task 6's `eventChannelFor` uses the same kebab logic as `toChannelName` — could be DRYed by importing, but inlined for clarity at the cost of 4 lines of duplication. Acceptable tradeoff.

---

## Execution Notes

- After Task 7 the code compiles but isn't manually tested yet. Task 8 is the verification.
- If any IPC channel breaks during Task 8, the fix is almost always either an override entry in `channel-name.ts` or a stub in `stubs.ts`. Don't refactor architecture — extend the maps.
- Per `CLAUDE.md`'s no-regressions policy: every task ends with `pnpm exec tsc --noEmit --pretty false`. Existing Electron build (`pnpm run compile`) should still work and is worth checking once at the end.
