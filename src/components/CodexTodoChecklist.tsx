interface TodoChecklistProps {
  input: Record<string, unknown>
}

export function CodexTodoChecklist({ input }: TodoChecklistProps) {
  const todos = input.todos as Array<{ content: string; status: string; activeForm?: string }> | undefined
  if (!todos || !Array.isArray(todos)) return null
  return (
    <div className="claude-todo-checklist">
      {todos.map((todo, i) => (
        <div key={i} className={`claude-todo-item claude-todo-${todo.status}`}>
          <span className="claude-todo-check">
            {todo.status === 'completed' ? '\u2611' : todo.status === 'in_progress' ? '\u25B6' : '\u2610'}
          </span>
          <span className="claude-todo-text">{todo.content}</span>
        </div>
      ))}
    </div>
  )
}
