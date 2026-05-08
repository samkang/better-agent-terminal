import { resolveChannel } from './channel-name'
import { WebWsClient } from './web-ws-client'
import {
  shellStubs, dialogStubs, imageStubs, clipboardStubs,
  appStubs, updateStubs, debugStubs, workspaceLocalStubs,
  remoteStubs, tunnelStubs, notificationStubs,
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
    remote: remoteStubs,
    tunnel: tunnelStubs,
    notification: notificationStubs,
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
// Event channel overrides — host uses camelCase for a handful of events.
// Sourced from electron/remote/protocol.ts PROXIED_EVENTS. Add to this map
// if a renderer subscription silently fails to receive events.
const EVENT_CHANNEL_OVERRIDES: Record<string, string> = {
  'claude:mode-change': 'claude:modeChange',
}

function eventChannelFor(namespace: string, method: string): string | null {
  if (!method.startsWith('on') || method.length < 3) return null
  // Trim 'on' and convert PascalCase → kebab-case
  const tail = method.slice(2)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
  const derived = `${namespace}:${tail}`
  return EVENT_CHANNEL_OVERRIDES[derived] ?? derived
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
