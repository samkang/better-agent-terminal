import React from 'react'
import ReactDOM from 'react-dom/client'
import { WebWsClient } from './web-ws-client'
import { buildBridge } from './web-api-bridge'
import '../i18n'
import '../styles/base.css'
import '../styles/layout.css'
import '../styles/panels.css'
import '../styles/settings.css'
import '../styles/context-menu.css'
import '../styles/notifications.css'
import '../styles/env-snippets.css'
import '../styles/resize.css'
import '../styles/file-browser.css'
import '../styles/path-linker.css'
import '../styles/prompt-box.css'
import '../styles/claude-agent.css'
import '../styles/skills-panel.css'

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

  const bootEl = document.getElementById('boot')
  if (bootEl) bootEl.remove()

  const root = document.getElementById('root')!
  ReactDOM.createRoot(root).render(<App />)
}

boot().catch((e) => {
  console.error('[web] boot failed', e)
  showError(`Boot failed: ${(e as Error).message}`)
})
