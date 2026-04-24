import { promises as fs } from 'fs'
import * as path from 'path'
import os from 'os'
import { getDataDir } from '../server-core/data-dir'
import { getSafeStorage } from '../server-core/safe-storage'
import { logger } from '../logger'

let keyFilePath: string | null = null
let cachedKey: string | null = null
let keySource: 'configured' | 'env' | 'codex-oauth' | null = null
let loaded = false

export type OpenAIKeySource = NonNullable<typeof keySource>

export interface OpenAIAuthCredential {
  apiKey: string
  source: OpenAIKeySource
  accountId?: string
}

function getKeyFilePath(): string {
  if (keyFilePath) return keyFilePath
  keyFilePath = path.join(getDataDir(), 'openai-api-key.bin')
  return keyFilePath
}

async function loadCodexOAuthCredential(): Promise<OpenAIAuthCredential | null> {
  const authPath = path.join(os.homedir(), '.codex', 'auth.json')
  try {
    const raw = await fs.readFile(authPath, 'utf8')
    const auth = JSON.parse(raw) as { tokens?: { access_token?: string; account_id?: string } }
    const token = auth?.tokens?.access_token
    if (token && typeof token === 'string' && token.length > 0) {
      logger.log('[openai-key] Using Codex OAuth access_token as fallback')
      return {
        apiKey: token,
        source: 'codex-oauth',
        accountId: typeof auth.tokens?.account_id === 'string' ? auth.tokens.account_id : undefined,
      }
    }
  } catch { /* auth.json missing or unreadable */ }
  return null
}

export async function hasCodexOAuthCredential(): Promise<boolean> {
  return !!(await loadCodexOAuthCredential())
}

export async function loadOpenAIAuthCredential(preferCodexOAuth = false): Promise<OpenAIAuthCredential | null> {
  if (preferCodexOAuth) {
    const codexCredential = await loadCodexOAuthCredential()
    if (codexCredential) return codexCredential
  }

  const apiKey = await loadOpenAIKey()
  const source = getKeySource()
  if (!apiKey || !source) return null

  if (source === 'codex-oauth') {
    const codexCredential = await loadCodexOAuthCredential()
    if (codexCredential) return codexCredential
  }

  return { apiKey, source }
}

export function getKeySource(): typeof keySource {
  return keySource
}

export async function loadOpenAIKey(): Promise<string | null> {
  if (loaded) return cachedKey
  const p = getKeyFilePath()
  try {
    const buf = await fs.readFile(p)
    const safeStorage = getSafeStorage()
    if (safeStorage.isEncryptionAvailable()) {
      cachedKey = safeStorage.decryptString(buf)
    } else {
      cachedKey = buf.toString('utf8')
    }
    if (cachedKey) keySource = 'configured'
  } catch {
    cachedKey = null
  }
  if (!cachedKey) {
    const codexCredential = await loadCodexOAuthCredential()
    if (codexCredential) {
      cachedKey = codexCredential.apiKey
      keySource = 'codex-oauth'
      // Don't set loaded — OAuth tokens expire and get refreshed by
      // the Codex CLI, so re-read auth.json on every call.
      return cachedKey
    }
  }
  if (!cachedKey && process.env.OPENAI_API_KEY) {
    cachedKey = process.env.OPENAI_API_KEY
    keySource = 'env'
  }
  loaded = true
  return cachedKey
}

export async function setOpenAIKey(key: string): Promise<void> {
  const p = getKeyFilePath()
  await fs.mkdir(path.dirname(p), { recursive: true })
  const safeStorage = getSafeStorage()
  const payload = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(key)
    : Buffer.from(key, 'utf8')
  await fs.writeFile(p, payload)
  cachedKey = key
  keySource = 'configured'
  loaded = true
}

export async function clearOpenAIKey(): Promise<void> {
  const p = getKeyFilePath()
  try { await fs.unlink(p) } catch { /* ignore */ }
  cachedKey = null
  keySource = null
  loaded = false
}

export async function hasOpenAIKey(): Promise<boolean> {
  const k = await loadOpenAIKey()
  return !!k && k.length > 0
}
