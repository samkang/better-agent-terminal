import { promises as fs } from 'fs'
import * as path from 'path'
import { z } from 'zod'
import { tool } from 'ai'
import { getToolContext } from './context'

const MAX_BYTES = 500_000

export const readTool = tool({
  description: 'Read a file from disk. Accepts absolute paths or paths relative to the working directory. Returns content with 1-based line numbers. Max 500KB.',
  inputSchema: z.object({
    path: z.string().describe('File path, absolute or relative to cwd'),
    offset: z.number().int().nonnegative().optional().describe('Start line (1-based, inclusive)'),
    limit: z.number().int().positive().optional().describe('Number of lines to read'),
  }),
  execute: async ({ path: filePath, offset, limit }, options) => {
    const ctx = getToolContext(options.experimental_context)
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.cwd, filePath)

    try {
      const stat = await fs.stat(abs)
      if (!stat.isFile()) return { error: `Not a file: ${abs}` }
      if (stat.size > MAX_BYTES) return { error: `File too large (${stat.size} bytes > ${MAX_BYTES}); specify offset+limit` }

      const content = await fs.readFile(abs, 'utf8')
      const lines = content.split('\n')
      const start = Math.max(0, (offset ?? 1) - 1)
      const end = limit ? Math.min(lines.length, start + limit) : lines.length
      const slice = lines.slice(start, end)
      const numbered = slice.map((line, i) => `${String(start + i + 1).padStart(5, ' ')}\t${line}`).join('\n')
      return { path: abs, totalLines: lines.length, fromLine: start + 1, toLine: end, content: numbered }
    } catch (err) {
      return { error: `Failed to read: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
})
