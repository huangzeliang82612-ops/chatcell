import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Capacitor WebView 需要相对路径资源，否则 origin 变成 https://localhost 后
  // 根路径 /assets/... 也能解析，但相对路径在 file:// 场景更稳。
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2020',
    sourcemap: false
  },
  server: {
    host: true,
    port: 5173
  }
})
