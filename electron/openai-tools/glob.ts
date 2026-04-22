import { promises as fs } from 'fs'
import * as path from 'path'
import { z } from 'zod'
import { tool } from 'ai'
import { getToolContext } from './context'

const MAX_RESULTS = 2000
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-electron', '.bat-worktrees', 'release', '.next', 'build', 'coverage', '.turbo', '.cache'])

export const globTool = tool({
  description: 'Find files matching a simple glob pattern (supports **, *, ? and literal paths). Returns file paths sorted by modification time (newest first).',
  inputSchema: z.object({
    pattern: z.string().describe('Glob pattern, e.g. "src/**/*.ts", "**/*.tsx"'),
    path: z.string().optional().describe('Root directory (absolute or relative to cwd). Default: cwd'),
  }),
  execute: async ({ pattern, path: rootArg }, options) => {
    const ctx = getToolContext(options.experimental_context)
    const root = rootArg
      ? (path.isAbsolute(rootArg) ? rootArg : path.resolve(ctx.cwd, rootArg))
      : ctx.cwd

    const regex = globToRegex(pattern)
    const matches: { file: string; mtimeMs: number }[] = []
    await walk(root, root, regex, matches, ctx.abortSignal)

    matches.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const files = matches.slice(0, MAX_RESULTS).map(m => m.file)
    return { pattern, root, count: files.length, truncated: matches.length > MAX_RESULTS, files }
  },
})

function globToRegex(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/')
  let re = ''
  let i = 0
  while (i < normalized.length) {
    const c = normalized[i]
    if (c === '*' && normalized[i + 1] === '*') {
      if (normalized[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 3
      } else {
        re += '.*'
        i += 2
      }
    } else if (c === '*') {
      re += '[^/]*'
      i++
    } else if (c === '?') {
      re += '[^/]'
      i++
    } else if ('.+^$()|[]{}'.includes(c)) {
      re += '\\' + c
      i++
    } else {
      re += c
      i++
    }
  }
  return new RegExp('^' + re + '$', process.platform === 'win32' ? 'i' : '')
}

async function walk(root: string, dir: string, regex: RegExp, out: { file: string; mtimeMs: number }[], abort: AbortSignal): Promise<void> {
  if (out.length >= MAX_RESULTS || abort.aborted) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch { return }
  for (const entry of entries) {
    if (out.length >= MAX_RESULTS || abort.aborted) return
    const full = path.join(dir, entry.name)
    const rel = path.relative(root, full).replace(/\\/g, '/')
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      await walk(root, full, regex, out, abort)
    } else if (entry.isFile()) {
      if (regex.test(rel)) {
        try {
          const stat = await fs.stat(full)
          out.push({ file: full, mtimeMs: stat.mtimeMs })
        } catch { /* ignore */ }
      }
    }
  }
}
