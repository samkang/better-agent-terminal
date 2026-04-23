export interface OpenAIModelInfo {
  value: string
  displayName: string
  description: string
  contextWindow: number
  maxOutputTokens: number
  supportsReasoning: boolean
}

export const OPENAI_MODELS: OpenAIModelInfo[] = [
  { value: 'gpt-5.4',       displayName: 'GPT-5.4',       description: 'Flagship GPT-5.4',           contextWindow: 1_050_000, maxOutputTokens: 128_000, supportsReasoning: true },
  { value: 'gpt-5.4-mini',  displayName: 'GPT-5.4 Mini',  description: 'Fast GPT-5.4',               contextWindow: 400_000,   maxOutputTokens: 128_000, supportsReasoning: true },
  { value: 'gpt-5.4-nano',  displayName: 'GPT-5.4 Nano',  description: 'Cheapest GPT-5.4',           contextWindow: 400_000,   maxOutputTokens: 128_000, supportsReasoning: true },
  { value: 'o3',            displayName: 'o3',            description: 'OpenAI o3 reasoning',        contextWindow: 200_000,   maxOutputTokens: 100_000, supportsReasoning: true },
  { value: 'o4-mini',       displayName: 'o4-mini',       description: 'OpenAI o4-mini reasoning',   contextWindow: 200_000,   maxOutputTokens: 100_000, supportsReasoning: true },
  { value: 'gpt-4.1',       displayName: 'GPT-4.1',       description: 'GPT-4.1',                    contextWindow: 1_000_000, maxOutputTokens: 32_768,  supportsReasoning: false },
  { value: 'gpt-4.1-mini',  displayName: 'GPT-4.1 Mini',  description: 'Fast GPT-4.1',               contextWindow: 1_000_000, maxOutputTokens: 32_768,  supportsReasoning: false },
]

export const DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini'

export const CODEX_CHATGPT_SUPPORTED_MODELS = new Set(['gpt-5.4', 'gpt-5.4-mini'])

export function findModel(id: string | undefined): OpenAIModelInfo | undefined {
  if (!id) return undefined
  return OPENAI_MODELS.find(m => m.value === id)
}
