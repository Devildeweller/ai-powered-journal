import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), '');
  const apiTarget = env.VITE_DEV_API_TARGET || 'http://localhost:4000';

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      // The browser only ever talks to this origin; /api is forwarded to the
      // Express server.  Production does the same with a Vercel rewrite, so the
      // refresh cookie is first-party in both environments.
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
      },
    },
  };
});
