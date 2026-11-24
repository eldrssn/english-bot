import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Кабинет лежит в src/web, сборка идёт в dist/web: оттуда её раздаёт сервер (WEB_DIST_DIR по умолчанию).
// При разработке API работает на :3000 (npm run dev:api), Vite проксирует запросы к нему.
export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:3000" },
  },
});
