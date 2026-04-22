import { promises as fs } from 'fs'
import * as path from 'path'
import { z } from 'zod'
import { tool } from 'ai'
import { getToolContext } from './context'

export const writeTool = tool({
  description: 'Write contents to a file, overwriting if it exists. Creates parent directories as needed. Requires approval unless permission mode is bypassPermissions/acceptEdits.',
  inputSchema: z.object({
    path: z.string().describe('File path, absolute or relative to cwd'),
    content: z.string().describe('Full file contents'),
  }),
  execute: async ({ path: filePath, content }, options) => {
    const ctx = getToolContext(options.experimental_context)
    const toolCallId = options.toolCallId
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.cwd, filePath)

    const needsApproval = ctx.permissionMode === 'default' || ctx.permissionMode === 'plan'
    if (needsApproval) {
      const ok = await ctx.requestPermission('Write', { path: abs, preview: content.slice(0, 500) }, toolCallId)
      if (!ok) return { denied: true, error: 'User denied write.' }
    }

    try {
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, content, 'utf8')
      return { path: abs, bytes: Buffer.byteLength(content, 'utf8') }
    } catch (err) {
      return { error: `Failed to write: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
})
