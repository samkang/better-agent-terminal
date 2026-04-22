import { promises as fs } from 'fs'
import * as path from 'path'
import * as os from 'os'

export interface SkillMeta {
  name: string
  description: string
  path: string
  scope: 'project' | 'global'
}

function parseFrontmatter(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!content.startsWith('---')) return out
  const end = content.indexOf('\n---', 3)
  if (end < 0) return out
  const block = content.slice(3, end).trim()
  for (const line of block.split('\n')) {
    const m = line.match(/^(\w[\w-]*)\s*:\s*(.+?)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
  return out
}

async function scanDir(dir: string, scope: 'project' | 'global'): Promise<SkillMeta[]> {
  const out: SkillMeta[] = []
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch { return out }

  for (const name of entries) {
    const full = path.join(dir, name)
    let stat
    try { stat = await fs.stat(full) } catch { continue }
    if (stat.isDirectory()) {
      const skillMd = path.join(full, 'SKILL.md')
      try {
        const content = await fs.readFile(skillMd, 'utf-8')
        const fm = parseFrontmatter(content)
        out.push({
          name: fm.name || name,
          description: fm.description || firstHeading(content),
          path: skillMd,
          scope,
        })
      } catch { /* no SKILL.md in this dir */ }
    } else if (stat.isFile() && name.endsWith('.md')) {
      const skillName = name.replace(/\.md$/, '')
      try {
        const content = await fs.readFile(full, 'utf-8')
        const fm = parseFrontmatter(content)
        out.push({
          name: fm.name || skillName,
          description: fm.description || firstHeading(content),
          path: full,
          scope,
        })
      } catch { /* skip */ }
    }
  }
  return out
}

function firstHeading(content: string): string {
  const body = content.replace(/^---[\s\S]*?\n---\n/, '')
  const line = body.split('\n').find(l => l.trim().length > 0) || ''
  return line.replace(/^#+\s*/, '').trim().slice(0, 200)
}

export async function scanSkills(cwd: string): Promise<SkillMeta[]> {
  const projectSkills = path.join(cwd, '.claude', 'skills')
  const globalSkills = path.join(os.homedir(), '.claude', 'skills')
  const [a, b] = await Promise.all([
    scanDir(projectSkills, 'project'),
    scanDir(globalSkills, 'global'),
  ])
  const seen = new Set<string>()
  const out: SkillMeta[] = []
  for (const s of [...a, ...b]) {
    if (seen.has(s.name)) continue
    seen.add(s.name)
    out.push(s)
  }
  return out
}

export function buildSkillsSystemPromptSection(skills: SkillMeta[]): string {
  if (!skills.length) return ''
  const lines = skills.map(s => `- ${s.name}: ${s.description || '(no description)'}`).join('\n')
  return `\n\nThe following skills are available via the Skill tool:\n${lines}\n\nWhen a skill matches the user's request, invoke it via Skill({ skill: "<name>" }) BEFORE other work. The tool returns markdown instructions you should follow.`
}
