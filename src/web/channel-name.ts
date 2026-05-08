/**
 * Convert an `electronAPI.<namespace>.<method>` call into the IPC channel name
 * used by the host (e.g. `pty.getCwd` → `pty:get-cwd`).
 *
 * Rule: lowercase namespace, then ':', then method converted from camelCase to
 * kebab-case. Note: a few host channels in this codebase use camelCase
 * (`snippet:getAll`, `git:getRoot`). Those are listed as overrides in stubs.ts
 * if/when they break in practice.
 */
export function toChannelName(namespace: string, method: string): string {
  const kebab = method
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
  return `${namespace}:${kebab}`
}
