import { logger } from '../logger'

let CodexClass: unknown = null

export async function getCodexClass(): Promise<unknown> {
  if (!CodexClass) {
    try {
      const sdk = await import('@openai/codex-sdk')
      CodexClass = (sdk as Record<string, unknown>).Codex || (sdk as Record<string, unknown>).default
    } catch (err) {
      logger.error('[codex] Failed to import @openai/codex-sdk:', err)
      const cause = err instanceof Error ? err.message : String(err)
      throw new Error(`Codex SDK not available: ${cause}`)
    }
  }
  return CodexClass
}
