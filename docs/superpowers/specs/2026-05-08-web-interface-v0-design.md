# Web Interface v0 — Design

**Date:** 2026-05-08
**Scope:** A2 — Solo demo with Claude + Terminal in browser, no auth, no multi-user.
**Goal:** Validate that the existing renderer + WS remoting infrastructure can be driven from a real browser, with Claude streaming and PTY xterm both working over WebSocket.

## Why

- The codebase already has a complete WS remoting layer (`electron/remote/`) with all `claude:*` and `pty:*` channels proxied (`protocol.ts:PROXIED_CHANNELS`).
- React renderer has zero direct Electron dependency — it only uses `window.electronAPI`, which is a thin bridge installed by `electron/preload.ts`.
- This means a browser can drive the same renderer if `window.electronAPI` is replaced with a WS-backed shim. This v0 proves that hypothesis.
- The bigger goal (multi-user web access via shared host) needs auth + isolation work later. v0 deliberately skips those to surface architectural problems first.

## Non-Goals

- Auth / multi-user isolation (deferred to later phase B).
- TLS / production deployment (deferred to phase C).
- Settings, workspace switching, profile, file picker, snippet panels (UI hidden for v0).
- Reconnect UX polish, login screen, dialog fallbacks beyond `alert()`.
- Touching `electron/`, `preload.ts`, existing Vite config, or any backend code.
- Production build of the web bundle. Dev mode only.

## Architecture

```
Browser
  index.web.html
    └─ src/web/main-web.tsx            (new entry)
        ├─ open WebSocket → bat-server
        ├─ install web-api-bridge as window.electronAPI
        └─ render <App>                (existing, unchanged)
              ↓ uses window.electronAPI
              ↓
          web-api-bridge (Proxy)
              ↓ RemoteFrame over ws
              ↓
       bat-server / RemoteServer       (existing, unchanged)
              ↓
       ClaudeAgentManager / PtyManager (existing, unchanged)
```

## Components

### 1. `src/web/web-api-bridge.ts` (new)

A drop-in `window.electronAPI` replacement, structurally identical to what `electron/preload.ts` exposes.

- **Invoke calls** (`api.claude.sendMessage(...)`, `api.pty.write(...)`): a Proxy intercepts property access and method calls, derives the IPC channel name from the path (`claude.sendMessage` → `claude:send-message`), wraps the call as a `RemoteFrame{type:'invoke'}` with a generated id, and returns a Promise that resolves on the matching `invoke-result` / rejects on `invoke-error`.
- **Channel name derivation rule:** `namespace.methodName` → `namespace:kebab-cased-method`. e.g. `pty.getCwd` → `pty:get-cwd`. Method names that already contain hyphens stay; camelCase converts. The mapping is deterministic.
- **Event subscriptions** (`api.pty.onOutput(cb)` etc.): bridge maintains a `Map<eventName, Set<callback>>`. When the ws receives a `RemoteFrame{type:'event'}`, dispatch to all callbacks for that event name. Returns an unsubscribe function for symmetry with the IPC API.
- **Special-case stubs** (called but not WS-routable):
  - `platform` — set to a string derived from server response or fallback `'web'`.
  - `shell.openExternal(url)` → `window.open(url, '_blank', 'noopener')`.
  - `image.readAsDataUrl(path)` — only used by Electron drag-drop with file paths; in browser, the image attach flow uses `<input type=file>` + `FileReader.readAsDataURL` directly without going through this API. Bridge stub returns rejected promise.
  - `dialog.*`, `app.newWindow`, `update.*`, `webUtils.*` — log warning, return rejected promise or `null`.
  - `clipboard.*` — back with `navigator.clipboard`.

The Proxy approach was chosen over hand-written namespaces: lower maintenance, automatic forward-compat with new IPC channels, and the type info comes from the existing `electron.d.ts` since the shim conforms to the same shape.

### 2. `src/web/main-web.tsx` (new)

The web entry point.

1. Read connection params from URL query: `?host=`, `?port=`, `?token=`. Default host: `localhost`. Port and token have no defaults — user copies them from the bat-server startup output (`bat-server` prints port + token on launch).
2. Open `WebSocket(ws://host:port)`. On open, send `{type:'auth', token}`. Wait for `auth-result`. On failure, render a fatal error.
3. Construct the bridge with the connected ws and assign to `window.electronAPI`.
4. Render `<App>` (reuse existing root component).
5. On ws close: render a "disconnected, reconnecting..." overlay; attempt reconnect with the same backoff strategy `RemoteClient` uses (3s base, 30s max). After reconnect, in v0 just reload the page (simpler than re-syncing state).

### 3. `index.web.html` (new)

Minimal HTML entry. Same as Electron's `index.html` but loads `src/web/main-web.tsx`. Lives in repo root for Vite resolution.

### 4. `vite.config.web.ts` (new)

A second Vite config with:
- `root` set so `index.web.html` is the entry.
- `build.outDir: 'dist-web'`.
- No Electron plugins (no `vite-plugin-electron`, no `vite-plugin-electron-renderer`).
- React plugin only.
- Optional dev-mode WS proxy (probably unnecessary since browser can hit `ws://localhost:<port>` directly; but include if CORS or mixed-content issues arise).

### 5. `package.json` scripts (modified)

Add:
```
"dev:web": "vite --config vite.config.web.ts"
```

Existing `dev`, `compile`, `build` are untouched.

## Data Flow

### Claude send + streaming

```
User types in browser → React onSubmit
  → window.electronAPI.claude.sendMessage(sid, prompt, images)
  → bridge proxies to RemoteFrame{invoke, channel:'claude:send-message'}
  → ws.send
  → RemoteServer.invokeHandler('claude:send-message')
  → ClaudeAgentManager._doSendMessage → runQuery
  → SDK generator emits messages
  → manager.send(channel, ...) → broadcastHub.broadcast
  → ws send RemoteFrame{event, channel:'claude:message'}
  → bridge dispatches to subscribers
  → CodexAgentPanel state updates → render
```

### Terminal input/output

```
xterm.onData(byte) → window.electronAPI.pty.write(tid, byte)
  → invoke 'pty:write' over ws
  → PtyManager.write → node-pty subprocess

shell stdout → node-pty.onData
  → PtyManager.emitOutput (8ms coalesce)
  → broadcastHub.broadcast 'pty:output'
  → ws → bridge → terminal.write(data)
```

The 8ms coalesce already in `PtyManager` is enough to prevent IPC spam; ws latency adds a small constant per chunk but throughput is unchanged.

## Error Handling

| Scenario | Behaviour |
|---|---|
| ws connect fails | Render fullscreen "Cannot connect to bat-server at host:port" with retry button |
| auth rejected | Render fullscreen "Auth failed" with link to query-string docs |
| ws closes mid-session | Show banner "Disconnected, reconnecting..." + auto-reconnect; on reconnect, reload page |
| invoke timeout (30s default) | Reject the promise; component handles like normal IPC error |
| Stub API called (`dialog.*`, `app.*`) | `console.warn` + return safe default (null/empty array/false) |
| Image dragged into Claude input | Bridge intercepts, uses FileReader, returns data URL synchronously without WS round-trip |

## Testing

v0 is a manual-testing prototype. Acceptance criteria:

1. Open `http://localhost:5173` after starting bat-server. Page loads.
2. Claude session can be created (Sonnet 4.6 default), prompt sent, streaming text appears, no console errors.
3. Tool call (e.g. ask Claude to `ls` a directory) renders correctly with status badges.
4. Terminal panel shows xterm, accepts keystrokes, displays shell output, handles `clear` and color escapes.
5. Restart bat-server → browser shows reconnecting banner → after reconnect, page auto-reloads and is usable.

No automated tests for v0 — the value is in finding architectural friction, which only manual exploration surfaces.

## Risks & Open Questions

1. **`window.electronAPI.platform` consumers.** Some components branch on platform. Bridge will expose the host's platform from a synthetic `getPlatform()` call answered by the server. If too many components break, fall back to `'web'` and add per-component branches.
2. **xterm `windowsPty` config.** Renderer reads `window.electronAPI.platform === 'win32'` to enable ConPTY mode. Bridge must serve the host's actual platform so xterm parses escape sequences correctly when the host is Windows.
3. **broadcastHub leakage.** If the same bat-server is also driving an Electron window, the browser will receive Electron's events too. Mitigation: run bat-server in pure server mode (no GUI) for v0. Phase B will introduce per-connection event filtering.
4. **Mixed-content / CORS.** Browsers may refuse `ws://` from `http://` mixed origins, but localhost-to-localhost is fine. If hosting on a non-loopback dev server, may need to align ports or use vite proxy.
5. **Memory growth.** Long-running tab + accumulating event listeners — bridge must clean up on `unsubscribe` calls. Verify with DevTools after 30 min of use.
6. **Type safety.** Proxy bridge has runtime-derived methods; TypeScript can't statically verify it conforms to `electron.d.ts`. Acceptable for v0; revisit if false-positive bugs appear.

## Out of Scope (Reserved for Later Phases)

| Phase | Scope |
|---|---|
| B | Per-user auth tokens, broadcast event filtering by `windowId`, login UI, multi-user isolation |
| C | TLS (wss + cert), production web bundle build, deployment docs, fallbacks for dialog/shell |
| Future | Browser-native file picker mapped to host fs, drag-drop file upload, mobile responsive layout, settings/profile UI on web |

## Estimated Effort

1.5 days for v0:
- Bridge (4-6h): Proxy implementation + event dispatch + stubs
- Web entry + HTML + Vite config (2-3h)
- Manual testing + bug fixes (3-4h)
