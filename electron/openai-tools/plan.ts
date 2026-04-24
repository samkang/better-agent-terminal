import { promises as fs } from 'fs'
import * as path from 'path'
import { z } from 'zod'
import { tool } from 'ai'
import { getToolContext, type OpenAIPermissionMode } from './context'

function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'plan'
}

function formatPlan(title: string, plan: string): string {
  const trimmedTitle = title.trim() || 'Execution Plan'
  const trimmedPlan = plan.trim()
  return `# ${trimmedTitle}\n\n${trimmedPlan}\n`
}

async function writePlanFile(cwd: string, title: string, plan: string): Promise<string> {
  const dir = path.join(cwd, '.better-terminal', 'plans')
  await fs.mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filePath = path.join(dir, `${stamp}-${slugifyTitle(title)}.md`)
  await fs.writeFile(filePath, formatPlan(title, plan), 'utf8')
  return filePath
}

export const enterPlanModeTool = tool({
  description: 'Switch OpenAI Direct into plan mode. Use this before investigation when the task needs a design or approval before edits.',
  inputSchema: z.object({
    reason: z.string().optional().describe('Short reason for entering plan mode'),
  }),
  execute: async ({ reason }, options) => {
    const ctx = getToolContext(options.experimental_context)
    ctx.setPermissionMode('plan')
    return {
      mode: 'plan',
      reason: reason?.trim() || 'Planning before execution',
    }
  },
})

export const exitPlanModeTool = tool({
  description: 'Submit a concrete execution plan for user approval. If approved, OpenAI Direct leaves plan mode and may continue with implementation.',
  inputSchema: z.object({
    title: z.string().describe('Short title for the plan'),
    plan: z.string().describe('Markdown plan with ordered steps, risks, and validation approach'),
  }),
  execute: async ({ title, plan }, options) => {
    const ctx = getToolContext(options.experimental_context)
    const toolCallId = options.toolCallId
    const currentMode = ctx.permissionMode

    if (currentMode !== 'plan' && currentMode !== 'bypassPlan') {
      return { error: 'ExitPlanMode can only be used while OpenAI Direct is in plan mode.' }
    }

    const planFilePath = await writePlanFile(ctx.cwd, title, plan)
    const approved = await ctx.requestPermission('ExitPlanMode', {
      title,
      planFilePath,
      decisionReason: 'Approve this plan and leave plan mode?',
    }, toolCallId)

    if (!approved) {
      return { denied: true, planFilePath, error: 'User rejected the plan. Remain in plan mode and revise the plan.' }
    }

    const nextMode: OpenAIPermissionMode = currentMode === 'bypassPlan' ? 'bypassPermissions' : 'default'
    ctx.setPermissionMode(nextMode)
    return { approved: true, planFilePath, nextMode }
  },
})
