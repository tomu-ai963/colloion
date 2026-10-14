/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 配信は Worker の assets（colloion.tomu-ai.dev）のルートなので base は既定の /
export default defineConfig({
  plugins: [react()],
  // 開発時は /api（同期 API と認証の中継）を wrangler dev へ渡す。
  // ブラウザからは同一オリジンに見えるので、Cookie も CORS も本番と同じ条件になる
  server: {
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    css: false,
  },
})
