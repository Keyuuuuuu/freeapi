import path from "node:path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "./src"),
      "~~": path.resolve(__dirname, "."),
    },
  },
  publicDir: path.resolve(__dirname, "src/public"),
  build: {
    outDir: "web-dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "src/entrypoints/options/index.html"),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/cors-proxy": {
        target: "https://freeapi.kenoma.me",
        changeOrigin: true,
        secure: false,
      },
    },
  },
})
