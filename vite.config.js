import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

// 从 package.json 读版本号，注入到前端代码里，设置页会显示出来
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

export default defineConfig({
  plugins: [react()],
  // Capacitor WebView 需要相对路径资源，否则 origin 变成 https://localhost 后
  // 根路径 /assets/... 也能解析，但相对路径在 file:// 场景更稳。
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version)
  },
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
