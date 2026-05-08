// Smoke test: connect to bat-server, auth, send one invoke, observe one event.
// Bypasses TLS verification (self-signed cert, same as Vite proxy does).
import WebSocket from 'ws'
import process from 'node:process'

const TOKEN = process.argv[2]
if (!TOKEN) { console.error('usage: node tests/web-smoke.mjs <token>'); process.exit(1) }

const URL = 'wss://127.0.0.1:9876'
const ws = new WebSocket(URL, { rejectUnauthorized: false })

const pending = new Map()
let nextId = 1
function send(frame) { ws.send(JSON.stringify(frame)) }
function invoke(channel, args = []) {
  return new Promise((resolve, reject) => {
    const id = String(nextId++)
    pending.set(id, { resolve, reject })
    send({ type: 'invoke', id, channel, args })
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error('invoke timeout: ' + channel))
    }, 5000)
  })
}

ws.on('open', async () => {
  console.log('[open] connected')
  // Auth
  send({ type: 'auth', id: 'auth-1', token: TOKEN, args: ['smoke', { windowId: null }] })
})

ws.on('message', async (raw) => {
  const f = JSON.parse(raw.toString())
  if (f.type === 'auth-result') {
    if (f.error) { console.error('[auth] FAIL:', f.error); process.exit(1) }
    console.log('[auth] OK')
    // Try a benign invoke that's in PROXIED_CHANNELS
    try {
      const home = await invoke('fs:home', [])
      console.log('[invoke] fs:home =>', home)
      const cwd = await invoke('git:branch', [home])
      console.log('[invoke] git:branch =>', cwd)
    } catch (e) {
      console.error('[invoke] error:', e.message)
    }
    ws.close()
    process.exit(0)
  } else if (f.type === 'invoke-result') {
    const p = pending.get(f.id); if (p) { pending.delete(f.id); p.resolve(f.result) }
  } else if (f.type === 'invoke-error') {
    const p = pending.get(f.id); if (p) { pending.delete(f.id); p.reject(new Error(f.error)) }
  } else if (f.type === 'event') {
    console.log('[event]', f.channel, JSON.stringify(f.args).slice(0, 100))
  } else if (f.type === 'ping') {
    send({ type: 'pong', id: f.id })
  }
})

ws.on('error', (e) => { console.error('[error]', e.message); process.exit(1) })
ws.on('close', () => { console.log('[close]') })
