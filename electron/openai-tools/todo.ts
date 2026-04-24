import { z } from 'zod'
import { tool } from 'ai'

const todoSchema = z.object({
  content: z.string().min(1).describe('Concrete task step'),
  status: z.enum(['pending', 'in_progress', 'completed']).describe('Current step status'),
  activeForm: z.string().optional().describe('Short phrase for the active work, if useful'),
})

export const todoWriteTool = tool({
  description: 'Create or update the current structured task checklist. Use for multi-step work after a plan is approved, and keep exactly one item in_progress.',
  inputSchema: z.object({
    todos: z.array(todoSchema).min(1).describe('Full current checklist, not a partial patch'),
  }),
  execute: async ({ todos }) => {
    const inProgress = todos.filter(todo => todo.status === 'in_progress').length
    if (inProgress > 1) {
      return { error: 'Only one todo may be in_progress at a time.' }
    }
    return {
      todos,
      total: todos.length,
      completed: todos.filter(todo => todo.status === 'completed').length,
      inProgress,
    }
  },
})
