import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const buildTimestamp = new Date().toISOString();

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_TIMESTAMP__: JSON.stringify(buildTimestamp),
  },
  server: {
    host: true,
  },
});
