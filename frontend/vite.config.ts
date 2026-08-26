import { networkInterfaces } from 'node:os'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { defineConfig } from 'vitest/config'
import { VitePWA } from 'vite-plugin-pwa'

// HTTPS via basicSsl rather than mkcert (stack-reference.md's suggestion):
// mkcert needs a system binary installed and a CA trusted in the OS store,
// both of which need privileges this environment doesn't have. basicSsl is
// a pure npm plugin — it generates a self-signed cert with no system
// install, at the cost of a one-time "not trusted" warning to click past
// on each device (the phone included) instead of a silently-trusted cert.
// getUserMedia only needs a secure context, not a *trusted* one — self-
// signed still satisfies that (plan.md §9).

// basicSsl's default cert only covers localhost/127.0.0.1 — a phone
// connecting over the LAN IP hits a hostname mismatch, which fails harder
// for service-worker registration than for the page itself (a plain page
// load can be "proceeded past"; a mismatched-hostname cert breaks SW
// registration outright). Detect this machine's actual LAN IPs at config
// time, the same way CORS in the backend avoids hardcoding one address —
// whoever runs this next is very likely on a different network.
function lanIPs(): string[] {
  const nets = networkInterfaces()
  const ips: string[] = []
  for (const iface of Object.values(nets)) {
    for (const net of iface ?? []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address)
    }
  }
  return ips
}

export default defineConfig({
  plugins: [
    react(),
    basicSsl({ domains: lanIPs() }),
    VitePWA({
      registerType: 'autoUpdate',
      devOptions: { enabled: true }, // service worker in dev too — camera access needs a secure context, so test the installed-PWA path early (stack-reference.md)
      manifest: {
        name: 'Script Mark Scanner',
        short_name: 'Marks',
        theme_color: '#ffffff',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
    }),
  ],
  server: {
    host: true, // bind all interfaces so the phone can reach it over LAN
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.ts'],
    globals: true,
  },
})
