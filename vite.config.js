//import { defineConfig } from "vitest/config";
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
 export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // "::" binds dual-stack (both 127.0.0.1 and ::1) so http://localhost:PORT
    // works no matter which address family the OS/browser resolves it to first.
    host: "::",
    strictPort: true,
  },
    test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.js"
  }
})


