import { promises as fs } from 'fs'
import * as path from 'path'
import { z } from 'zod'
import { tool } from 'ai'
import { getToolContext } from './context'

const MAX_FILES = 5000
const MAX_MATCHES_DEFAULT = 200
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-electron', '.bat-worktrees', 'release', '.next', 'build', 'coverage', '.turbo', '.cache'])

export const grepTool = tool({
  description: 'Recursively search for a regex pattern in files under a directory. Returns matching file paths with line numbers and content. Skips node_modules, .git, dist by default.',
  inputSchema: z.object({
    pattern: z.string().describe('Regular expression pattern (JavaScript regex syntax)'),
    path: z.string().optional().describe('Directory to search (absolute or relative to cwd). Default: cwd'),
    glob: z.string().optional().describe('Optional file extension filter, e.g. ".ts" or ".{ts,tsx}"'),
    caseInsensitive: z.boolean().optional(),
    maxMatches: z.number().int().positive().optional(),
  }),
  execute: async ({ pattern, path: searchPath, glob, caseInsensitive, maxMatches }, options) => {
    const ctx = getToolContext(options.experimental_context)
    const root = searchPath
      ? (path.isAbsolute(searchPath) ? searchPath : path.resolve(ctx.cwd, searchPath))
      : ctx.cwd
    const cap = maxMatches ?? MAX_MATCHES_DEFAULT

    let regex: RegExp
    try {
      regex = new RegExp(pattern, caseInsensitive ? 'gi' : 'g')
    } catch (err) {
      return { error: `Invalid regex: ${err instanceof Error ? err.message : String(err)}` }
    }

    const extFilter = parseGlob(glob)
    const files: string[] = []
    await walk(root, files, MAX_FILES, extFilter, ctx.abortSignal)

    const matches: { file: string; line: number; text: string }[] = []
    for (const file of files) {
      if (matches.length >= cap) break
      if (ctx.abortSignal.aborted) break
      try {
        const content = await fs.readFile(file, 'utf8')
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          regex.lastIndex = 0
          if (regex.test(lines[i])) {
            matches.push({ file, line: i + 1, text: lines[i].slice(0, 500) })
            if (matches.length >= cap) break
          }
        }
      } catch { /* binary/unreadable, skip */ }
    }

    return { pattern, root, filesScanned: files.length, matches, truncated: matches.length >= cap }
  },
})

function parseGlob(glob?: string): ((file: string) => boolean) | null {
  if (!glob) return null
  const m = glob.match(/^\.?\{([^}]+)\}$/)
  if (m) {
    const exts = m[1].split(',').map(s => s.trim()).filter(Boolean).map(s => s.startsWith('.') ? s : '.' + s)
    return (f) => exts.some(e => f.endsWith(e))
  }
  const ext = glob.startsWith('.') ? glob : '.' + glob
  return (f) => f.endsWith(ext)
}

async function walk(dir: string, out: string[], cap: number, filter: ((f: string) => boolean) | null, abort: AbortSignal): Promise<void> {
  if (out.length >= cap || abort.aborted) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch { return }
  for (const entry of entries) {
    if (out.length >= cap || abort.aborted) return
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      await walk(full, out, cap, filter, abort)
    } else if (entry.isFile()) {
      if (filter && !filter(full)) continue
      out.push(full)
    }
  }
}
