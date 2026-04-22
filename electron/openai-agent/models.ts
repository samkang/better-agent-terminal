export interface OpenAIModelInfo {
  value: string
  displayName: string
  description: string
  contextWindow: number
  maxOutputTokens: number
  supportsReasoning: boolean
}

export const OPENAI_MODELS: OpenAIModelInfo[] = [
  { value: 'gpt-4.1',       displayName: 'GPT-4.1',       description: 'Flagship GPT-4.1',           contextWindow: 1_000_000, maxOutputTokens: 32_768, supportsReasoning: false },
  { value: 'gpt-4.1-mini',  displayName: 'GPT-4.1 Mini',  description: 'Fast GPT-4.1',               contextWindow: 1_000_000, maxOutputTokens: 32_768, supportsReasoning: false },
  { value: 'gpt-4o',        displayName: 'GPT-4o',        description: 'GPT-4o omni',                contextWindow: 128_000,   maxOutputTokens: 16_384, supportsReasoning: false },
  { value: 'gpt-4o-mini',   displayName: 'GPT-4o Mini',   description: 'Cheap & fast GPT-4o',        contextWindow: 128_000,   maxOutputTokens: 16_384, supportsReasoning: false },
  { value: 'o3',            displayName: 'o3',            description: 'OpenAI o3 reasoning',        contextWindow: 200_000,   maxOutputTokens: 100_000, supportsReasoning: true },
  { value: 'o4-mini',       displayName: 'o4-mini',       description: 'OpenAI o4-mini reasoning',   contextWindow: 200_000,   maxOutputTokens: 100_000, supportsReasoning: true },
]

export const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini'

export function findModel(id: string | undefined): OpenAIModelInfo | undefined {
  if (!id) return undefined
  return OPENAI_MODELS.find(m => m.value === id)
}
