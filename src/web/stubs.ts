/**
 * Stubs for Electron-only APIs that cannot be proxied over WebSocket.
 * Some are mapped to browser-native equivalents; others log a warning and
 * return a safe default.
 */

function warn(name: string): void {
  console.warn(`[web] ${name} is not available in browser; returning stub value`)
}

export const shellStubs = {
  openExternal: (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer')
    return Promise.resolve()
  },
  openPath: (folderPath: string) => {
    warn(`shell.openPath(${folderPath})`)
    return Promise.resolve()
  },
  getPathForFile: (_file: File) => '', // Electron-only API; no equivalent
}

export const dialogStubs = {
  selectFolder: () => { warn('dialog.selectFolder'); return Promise.resolve(null) },
  selectImages: () => { warn('dialog.selectImages'); return Promise.resolve([]) },
  selectFiles: () => { warn('dialog.selectFiles'); return Promise.resolve([]) },
  confirm: (msg: string) => Promise.resolve(window.confirm(msg)),
}

export const imageStubs = {
  readAsDataUrl: (_filePath: string) => {
    warn('image.readAsDataUrl — use FileReader on browser File objects directly')
    return Promise.reject(new Error('Not available in web'))
  },
  saveDataUrl: (_dataUrl: string, _defaultName?: string) => {
    warn('image.saveDataUrl')
    return Promise.resolve(null)
  },
}

export const clipboardStubs = {
  saveImage: () => { warn('clipboard.saveImage'); return Promise.resolve(null) },
  writeImage: (_filePath: string) => { warn('clipboard.writeImage'); return Promise.resolve(false) },
  writeText: async (text: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (e) {
      console.warn('[web] clipboard.writeText failed:', e)
      return false
    }
  },
  onCopyShortcut: (_cb: () => void) => () => {}, // No-op unsubscriber
}

export const appStubs = {
  openNewInstance: (_id: string) => { warn('app.openNewInstance'); return Promise.resolve() },
  newWindow: () => { warn('app.newWindow'); return Promise.resolve('') },
  focusNextWindow: () => Promise.resolve(false),
  setDockBadge: (_n: number) => { /* no-op */ },
  // Window-identity stubs — return null so renderer treats this as "default" window
  getWindowId: () => Promise.resolve(null),
  getWindowProfile: () => Promise.resolve(null),
  getWindowIndex: () => Promise.resolve(0),
  getLaunchProfile: () => Promise.resolve(null),
}

export const updateStubs = {
  check: () => Promise.resolve(null),
  getVersion: () => Promise.resolve('web'),
}

export const debugStubs = {
  log: (...args: unknown[]) => console.log('[debug]', ...args),
  isDebugMode: false,
}

export const workspaceLocalStubs = {
  // window.location.search-derived; safe to compute in browser
  getDetachedId: () => new URLSearchParams(window.location.search).get('detached'),
}
