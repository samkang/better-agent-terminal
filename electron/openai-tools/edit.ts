import { promises as fs } from 'fs'
import * as path from 'path'
import { z } from 'zod'
import { tool } from 'ai'
import { getToolContext } from './context'

export const editTool = tool({
  description: 'Replace exact text in a file. The old_string must be unique in the file (or use replace_all). Useful for surgical edits; prefer this over Write when changing part of a file.',
  inputSchema: z.object({
    path: z.string().describe('File path, absolute or relative to cwd'),
    old_string: z.string().describe('The exact text to replace. Must be unique unless replace_all is true.'),
    new_string: z.string().describe('The replacement text'),
    replace_all: z.boolean().optional().describe('If true, replace every occurrence'),
  }),
  execute: async ({ path: filePath, old_string, new_string, replace_all }, options) => {
    const ctx = getToolContext(options.experimental_context)
    const toolCallId = options.toolCallId
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.cwd, filePath)

    try {
      const original = await fs.readFile(abs, 'utf8')

      if (old_string === new_string) return { error: 'old_string and new_string are identical.' }

      const count = countOccurrences(original, old_string)
      if (count === 0) return { error: `old_string not found in ${abs}` }
      if (count > 1 && !replace_all) return { error: `old_string matches ${count} times; use replace_all or provide a more specific snippet.` }

      const needsApproval = ctx.permissionMode === 'default' || ctx.permissionMode === 'plan'
      if (needsApproval) {
        const ok = await ctx.requestPermission('Edit', { path: abs, old_string: old_string.slice(0, 300), new_string: new_string.slice(0, 300) }, toolCallId)
        if (!ok) return { denied: true, error: 'User denied edit.' }
      }

      const updated = replace_all
        ? original.split(old_string).join(new_string)
        : original.replace(old_string, new_string)
      await fs.writeFile(abs, updated, 'utf8')
      return { path: abs, replacements: replace_all ? count : 1 }
    } catch (err) {
      return { error: `Failed to edit: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
})

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let idx = 0
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++
    idx += needle.length
  }
  return count
}
