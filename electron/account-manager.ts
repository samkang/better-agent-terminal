import { app, safeStorage } from 'electron'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as path from 'path'
import { execFile, execSync } from 'child_process'
import { logger } from './logger'
import * as os from 'os'

export interface ClaudeAccount {
  id: string
  email: string
  subscriptionType?: string
  isDefault: boolean
  createdAt: number
}

interface AccountStore {
  accounts: ClaudeAccount[]
  activeAccountId: string | null
  switchWarningShown: boolean
}

interface EncryptedCredentialFile {
  [accountId: string]: string // base64-encoded encrypted credential
}

const STORE_FILE = 'claude-accounts.json'
const ENCRYPTED_CREDS_FILE = 'claude-account-creds.enc.json'
const isDarwin = process.platform === 'darwin'
const CLI_KEYCHAIN_SERVICE = 'Claude Code-credentials'

function getKeychainAccount(): string {
  return process.env.USER || os.userInfo().username
}

function getClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

// --- Platform-specific CLI credential read/write ---

function readCliCredentials(): string | null {
  if (isDarwin) {
    try {
      const account = getKeychainAccount()
      return execSync(
        `security find-generic-password -a "${account}" -s "${CLI_KEYCHAIN_SERVICE}" -w`,
        { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim() || null
    } catch {
      return null
    }
  }
  // Windows/Linux: CLI stores credentials in .credentials.json
  try {
    const credPath = path.join(getClaudeConfigDir(), '.credentials.json')
    return fsSync.readFileSync(credPath, 'utf-8').trim() || null
  } catch {
    return null
  }
}

function writeCliCredentials(credentialJson: string): boolean {
  if (isDarwin) {
    try {
      const account = getKeychainAccount()
      execSync(
        `security add-generic-password -U -a "${account}" -s "${CLI_KEYCHAIN_SERVICE}" -w "${credentialJson.replace(/"/g, '\\"')}"`,
        { timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
      )
      return true
    } catch {
      logger.error('[account-manager] Failed to write CLI keychain credentials')
      return false
    }
  }
  // Windows/Linux: write .credentials.json
  try {
    const credPath = path.join(getClaudeConfigDir(), '.credentials.json')
    fsSync.writeFileSync(credPath, credentialJson, { encoding: 'utf-8', mode: 0o600 })
    return true
  } catch {
    logger.error('[account-manager] Failed to write CLI credentials file')
    return false
  }
}

// --- Encrypted credential backup (safeStorage) ---

function getEncryptedCredsPath(): string {
  return path.join(app.getPath('userData'), ENCRYPTED_CREDS_FILE)
}

function loadEncryptedCreds(): EncryptedCredentialFile {
  try {
    return JSON.parse(fsSync.readFileSync(getEncryptedCredsPath(), 'utf-8'))
  } catch {
    return {}
  }
}

function saveEncryptedCreds(creds: EncryptedCredentialFile): void {
  fsSync.writeFileSync(getEncryptedCredsPath(), JSON.stringify(creds, null, 2), { encoding: 'utf-8', mode: 0o600 })
}

function encryptCredential(plaintext: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) {
    logger.error('[account-manager] safeStorage encryption not available')
    return null
  }
  return safeStorage.encryptString(plaintext).toString('base64')
}

function decryptCredential(encrypted: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) {
    logger.error('[account-manager] safeStorage decryption not available')
    return null
  }
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    logger.error('[account-manager] Failed to decrypt credential')
    return null
  }
}

// --- Account Manager ---

class AccountManager {
  private store: AccountStore = { accounts: [], activeAccountId: null, switchWarningShown: false }
  private loaded = false

  private getStorePath(): string {
    return path.join(app.getPath('userData'), STORE_FILE)
  }

  async load(): Promise<void> {
    if (this.loaded) return
    try {
      const data = await fs.readFile(this.getStorePath(), 'utf-8')
      this.store = JSON.parse(data)
      // Strip credentialSnapshot from legacy store (moved to encrypted storage)
      let dirty = false
      for (const a of this.store.accounts) {
        if ('credentialSnapshot' in a) {
          delete (a as Record<string, unknown>).credentialSnapshot
          dirty = true
        }
      }
      if (dirty) await this.save()
    } catch {
      this.store = { accounts: [], activeAccountId: null, switchWarningShown: false }
    }
    this.loaded = true
  }

  private async save(): Promise<void> {
    await fs.writeFile(this.getStorePath(), JSON.stringify(this.store, null, 2), 'utf-8')
  }

  getAccounts(): ClaudeAccount[] {
    return this.store.accounts
  }

  getActiveAccountId(): string | null {
    return this.store.activeAccountId
  }

  getActiveAccount(): ClaudeAccount | null {
    if (!this.store.activeAccountId) return null
    return this.store.accounts.find(a => a.id === this.store.activeAccountId) || null
  }

  isSwitchWarningShown(): boolean {
    return this.store.switchWarningShown
  }

  async markSwitchWarningShown(): Promise<void> {
    this.store.switchWarningShown = true
    await this.save()
  }

  private saveAccountCredential(accountId: string, credentialJson: string): boolean {
    const encrypted = encryptCredential(credentialJson)
    if (!encrypted) return false
    const creds = loadEncryptedCreds()
    creds[accountId] = encrypted
    saveEncryptedCreds(creds)
    return true
  }

  private loadAccountCredential(accountId: string): string | null {
    const creds = loadEncryptedCreds()
    if (!creds[accountId]) return null
    return decryptCredential(creds[accountId])
  }

  private deleteAccountCredential(accountId: string): void {
    const creds = loadEncryptedCreds()
    delete creds[accountId]
    saveEncryptedCreds(creds)
  }

  private getAuthStatus(): Promise<{ loggedIn: boolean; email?: string; subscriptionType?: string; authMethod?: string } | null> {
    return new Promise((resolve) => {
      execFile('claude', ['auth', 'status'], { timeout: 10000 }, (err, stdout, stderr) => {
        if (err) {
          logger.error('[account-manager] auth status failed:', err.message, stderr)
          resolve(null)
        } else {
          try { resolve(JSON.parse(stdout)) } catch (e) {
            logger.error('[account-manager] auth status parse failed:', stdout)
            resolve(null)
          }
        }
      })
    })
  }

  async importCurrentAccount(): Promise<ClaudeAccount | null> {
    const status = await this.getAuthStatus()
    if (!status?.loggedIn || !status.email) {
      logger.log('[account-manager] importCurrentAccount: no auth status or not logged in', JSON.stringify(status))
      return null
    }

    const cred = readCliCredentials()
    if (!cred) {
      logger.log('[account-manager] importCurrentAccount: no CLI credentials found')
      return null
    }

    const existing = this.store.accounts.find(a => a.email === status.email)
    if (existing) {
      existing.subscriptionType = status.subscriptionType
      this.saveAccountCredential(existing.id, cred)
      await this.save()
      return existing
    }

    const account: ClaudeAccount = {
      id: `default-${Date.now()}`,
      email: status.email,
      subscriptionType: status.subscriptionType,
      isDefault: true,
      createdAt: Date.now(),
    }
    this.saveAccountCredential(account.id, cred)
    this.store.accounts.push(account)
    if (!this.store.activeAccountId) {
      this.store.activeAccountId = account.id
    }
    await this.save()
    return account
  }

  async loginNewAccount(): Promise<{ success: boolean; account?: ClaudeAccount; error?: string }> {
    const activeAccount = this.getActiveAccount()
    const backupCred = readCliCredentials()

    const loginResult = await new Promise<{ success: boolean; error?: string }>((resolve) => {
      execFile('claude', ['auth', 'login'], { timeout: 120000 }, (err) => {
        if (err) {
          logger.error('[account-manager] login error:', err)
          resolve({ success: false, error: err.message })
        } else {
          resolve({ success: true })
        }
      })
    })

    if (!loginResult.success) {
      return { success: false, error: loginResult.error }
    }

    const status = await this.getAuthStatus()
    if (!status?.loggedIn || !status.email) {
      if (backupCred) writeCliCredentials(backupCred)
      return { success: false, error: 'Login completed but could not verify account' }
    }

    const newCred = readCliCredentials()
    if (!newCred) {
      if (backupCred) writeCliCredentials(backupCred)
      return { success: false, error: 'Could not read credentials after login' }
    }

    const existing = this.store.accounts.find(a => a.email === status.email)
    if (existing) {
      existing.subscriptionType = status.subscriptionType
      this.saveAccountCredential(existing.id, newCred)
      await this.save()
      if (backupCred && activeAccount && activeAccount.id !== existing.id) {
        writeCliCredentials(backupCred)
      }
      return { success: true, account: existing }
    }

    const account: ClaudeAccount = {
      id: `account-${Date.now()}`,
      email: status.email,
      subscriptionType: status.subscriptionType,
      isDefault: false,
      createdAt: Date.now(),
    }
    this.saveAccountCredential(account.id, newCred)
    this.store.accounts.push(account)
    await this.save()

    if (backupCred && activeAccount) {
      writeCliCredentials(backupCred)
    }

    return { success: true, account }
  }

  async switchAccount(accountId: string): Promise<boolean> {
    const account = this.store.accounts.find(a => a.id === accountId)
    if (!account) return false

    const currentActive = this.getActiveAccount()
    if (currentActive) {
      const currentCred = readCliCredentials()
      if (currentCred) this.saveAccountCredential(currentActive.id, currentCred)
    }

    const cred = this.loadAccountCredential(accountId)
    if (!cred) return false

    const success = writeCliCredentials(cred)
    if (!success) return false

    this.store.activeAccountId = accountId
    await this.save()
    logger.log(`[account-manager] Switched to account: ${account.email}`)
    return true
  }

  async removeAccount(accountId: string): Promise<boolean> {
    const account = this.store.accounts.find(a => a.id === accountId)
    if (!account) return false
    if (account.isDefault) return false

    this.deleteAccountCredential(accountId)
    this.store.accounts = this.store.accounts.filter(a => a.id !== accountId)

    if (this.store.activeAccountId === accountId) {
      const defaultAccount = this.store.accounts.find(a => a.isDefault)
      this.store.activeAccountId = defaultAccount?.id || this.store.accounts[0]?.id || null
      const fallback = this.getActiveAccount()
      if (fallback) {
        const fallbackCred = this.loadAccountCredential(fallback.id)
        if (fallbackCred) writeCliCredentials(fallbackCred)
      }
    }
    await this.save()
    return true
  }
}

export const accountManager = new AccountManager()
