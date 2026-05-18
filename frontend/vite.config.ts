import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const apiTarget = process.env.VITE_API_TARGET ?? 'http://localhost:8080'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/t': {
        target: apiTarget,
        changeOrigin: true,
        bypass: (request) => {
          const userAgent = request.headers['user-agent'] ?? ''
          const crawlerPattern =
            /Twitterbot|facebookexternalhit|WhatsApp|Slackbot|LinkedInBot|Discordbot|TelegramBot/i
          return crawlerPattern.test(String(userAgent)) ? undefined : '/index.html'
        },
      },
    },
  },
})
