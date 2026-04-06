import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve(__dirname, 'viewer'),
  plugins: [react()],
  build: {
    emptyOutDir: true,
    outDir: resolve(__dirname, 'viewer-dist'),
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
})
