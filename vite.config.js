import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_TARGET = process.env.VITE_DEV_API_URL || "http://localhost:3333";
const EMPTY_MODULE = fileURLToPath(new URL("./admin/src/services/empty-module.js", import.meta.url));

// O codigo-fonte do painel fica em /admin, mas o build acontece na raiz para
// que a Vercel publique tudo (painel + API) em um unico projeto.
export default defineConfig({
  root: "admin",
  plugins: [react()],
  resolve: {
    alias: {
      // O jsPDF importa canvg/html2canvas/dompurify apenas para renderizar SVG e
      // HTML. A exportacao do painel usa somente tabelas, entao esses modulos
      // opcionais viram stubs vazios e ficam de fora do bundle.
      canvg: EMPTY_MODULE,
      html2canvas: EMPTY_MODULE,
      dompurify: EMPTY_MODULE
    }
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    sourcemap: false
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
      "/health": { target: API_TARGET, changeOrigin: true }
    }
  }
});
