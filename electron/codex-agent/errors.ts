export function stringifyCodexError(error: unknown, fallback = 'Unknown error'): string {
  if (!error) return fallback
  if (typeof error === 'string') return annotateCodexError(error)
  if (error instanceof Error) return annotateCodexError(error.message || fallback)
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>
    const nested = record.message ?? record.error ?? record.cause
    if (typeof nested === 'string' && nested.trim()) return annotateCodexError(nested)
    try {
      return annotateCodexError(JSON.stringify(error))
    } catch {
      return annotateCodexError(String(error))
    }
  }
  return annotateCodexError(String(error))
}

function annotateCodexError(message: string): string {
  if (/The model `[^`]+` does not exist or you do not have access to it/i.test(message)) {
    return `${message}\n\nHint: try upgrading codex CLI (npm i -g @openai/codex) — new models like gpt-5.5 need a recent CLI.`
  }
  return message
}
