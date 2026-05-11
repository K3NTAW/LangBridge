import { defineConfig, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const host = process.env["TAURI_DEV_HOST"];

const serverConfig: UserConfig["server"] = {
  port: 1420,
  strictPort: true,
  host: host ?? false,
  watch: {
    ignored: ["**/src-tauri/**"],
  },
};

if (host) {
  serverConfig.hmr = {
    protocol: "ws",
    host,
    port: 1421,
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },

  // Tauri expects the dev server on a fixed port; Vite would choose a
  // different port if 1420 were taken, which breaks the Tauri window.
  clearScreen: false,
  server: serverConfig,
});
