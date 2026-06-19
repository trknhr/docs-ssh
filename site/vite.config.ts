import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  base: process.env.DOCS_SITE_BASE ?? '/',
  build: {
    emptyOutDir: true,
    outDir: resolve(__dirname, '../site-dist'),
  },
  root: __dirname,
  server: {
    host: '0.0.0.0',
    port: 5174,
  },
})
