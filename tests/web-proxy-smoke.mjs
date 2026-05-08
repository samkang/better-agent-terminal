// Smoke test through Vite proxy: connect to ws://localhost:5173/ws
// (no TLS — Vite terminates the wss connection upstream).
import WebSocket from 'ws'
import process from 'node:process'

const TOKEN = process.argv[2]
if (!TOKEN) { console.error('usage: node tests/web-proxy-smoke.mjs <token>'); process.exit(1) }

const URL = 'ws://localhost:5173/ws'
const ws = new WebSocket(URL)

ws.on('open', () => {
  console.log('[open] connected via Vite proxy')
  ws.send(JSON.stringify({ type: 'auth', id: 'a1', token: TOKEN, args: ['proxy-smoke', { windowId: null }] }))
})

ws.on('message', (raw) => {
  const f = JSON.parse(raw.toString())
  if (f.type === 'auth-result') {
    if (f.error) { console.error('[auth] FAIL:', f.error); process.exit(1) }
    console.log('[auth] OK — Vite proxy is forwarding wss correctly')
    ws.send(JSON.stringify({ type: 'invoke', id: 'i1', channel: 'fs:home', args: [] }))
  } else if (f.type === 'invoke-result') {
    console.log('[invoke] result:', f.result)
    ws.close()
    process.exit(0)
  }
})

ws.on('error', (e) => { console.error('[error]', e.message); process.exit(1) })
ws.on('close', () => console.log('[close]'))
