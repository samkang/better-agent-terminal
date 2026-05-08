import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Rewrite `/` (and `/?...`) to `/index.web.html` so the bare host loads the
// web entry, not Electron's `index.html` which doesn't install the WS bridge
// and would crash on `window.electronAPI` access.
function rewriteRootToWebEntry(): Plugin {
  return {
    name: 'rewrite-root-to-web-entry',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/' || req.url?.startsWith('/?')) {
          const query = req.url.slice(1) // '' or '?...'
          req.url = `/index.web.html${query}`
        }
        next()
      })
    },
  }
}

// Web target — no Electron plugins, no electron-renderer.
// Dev proxy bypasses the self-signed TLS cert that bat-server uses.
export default defineConfig({
  plugins: [react(), rewriteRootToWebEntry()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist-web',
    rollupOptions: {
      input: path.resolve(__dirname, 'index.web.html'),
    },
  },
  server: {
    port: 5173,
    open: '/index.web.html',
    proxy: {
      // Browser opens ws://localhost:5173/ws → Vite forwards to wss://localhost:9876
      // with TLS verification disabled (self-signed cert).
      '/ws': {
        target: 'wss://localhost:9876',
        ws: true,
        secure: false,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ws/, ''),
      },
    },
  },
})
