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

/**
 * Channel name overrides — host uses camelCase or other non-kebab forms for
 * some channels. Look these up before falling back to toChannelName().
 *
 * Sourced from electron/preload.ts ipcRenderer.invoke() literals.
 */
const OVERRIDES: Record<string, string> = {
  'snippet.getAll': 'snippet:getAll',
  'snippet.getById': 'snippet:getById',
  'snippet.toggleFavorite': 'snippet:toggleFavorite',
  'snippet.getCategories': 'snippet:getCategories',
  'snippet.getFavorites': 'snippet:getFavorites',
  'snippet.getByWorkspace': 'snippet:getByWorkspace',
  'git.getRoot': 'git:getRoot',
  'fs.readFile': 'fs:readFile',
  'fs.readdir': 'fs:readdir',
  'workerBuffer.readAll': 'worker-buffer:readAll',
  'workerBuffer.init': 'worker-buffer:init',
  'workerBuffer.append': 'worker-buffer:append',
  'workerBuffer.clear': 'worker-buffer:clear',
}

export function resolveChannel(namespace: string, method: string): string {
  const key = `${namespace}.${method}`
  return OVERRIDES[key] ?? toChannelName(namespace, method)
}
