import { promises as fs } from 'fs'
import { z } from 'zod'
import { tool } from 'ai'
import { getToolContext } from './context'

export const skillTool = tool({
  description: 'Load a named skill and return its markdown instructions to follow. Only use skills that appear in the available-skills list from the system prompt.',
  inputSchema: z.object({
    skill: z.string().describe('Exact skill name from the available-skills list'),
    args: z.string().optional().describe('Optional arguments for the skill'),
  }),
  execute: async ({ skill, args }, options) => {
    const ctx = getToolContext(options.experimental_context)
    const meta = ctx.skills.get(skill)
    if (!meta) return { error: `Unknown skill: ${skill}. Available: ${[...ctx.skills.keys()].join(', ') || '(none)'}` }
    try {
      const content = await fs.readFile(meta.path, 'utf-8')
      return { skill, scope: meta.scope, path: meta.path, content, args: args ?? '' }
    } catch (err) {
      return { error: `Failed to load skill: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
})
