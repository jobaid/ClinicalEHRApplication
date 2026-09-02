//import { defineConfig } from "vitest/config";
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
 export default defineConfig({ 
  plugins: [react(), tailwindcss()], 
    test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.js"
  }
})


