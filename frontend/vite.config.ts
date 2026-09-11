import { readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import { VitePWA } from 'vite-plugin-pwa'
import { injectLandingShell } from './scripts/landing-shell.mjs'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

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

// step.md 14.5/14.6 (plan.md §19) gave `npm run build` a real, zero-
// runtime-JS prerendered landing page via scripts/prerender-landing.mjs —
// but that script only ever touches dist/index.html, which `vite dev`
// never serves (it serves this file, index.html, straight off disk with
// only its HMR client injected). The practical effect: under `./dev.sh`,
// the landing page never appeared at all — not on a first visit, not via
// Library's "way back" link, since neither the static markup, the
// bootstrap script, nor the critical CSS existed anywhere in the dev
// server's output. Found from actual use, not a test: every automated
// check here (Landing.test.tsx, prerender.test.ts) exercises either the
// component in isolation or the real BUILD output — nobody had opened
// `npm run dev` and looked.
//
// The fix mirrors the build-time script exactly, using landing-shell.mjs
// (the same injection code, imported by both) so dev and prod cannot
// drift apart on what actually gets injected. `server.ssrLoadModule` is
// Vite's own supported way to run application source (JSX, TS, the
// works) through its dev-time transform pipeline for exactly this kind
// of purpose — no second toolchain, no new dependency. `apply: 'serve'`
// keeps this out of `vite build` entirely, where prerender-landing.mjs
// already does the equivalent work against the real bundled output.
// Exported (not just used below) so landingShellDev.test.ts can drive it
// directly through a real Vite dev server in middleware mode, rather than
// trusting that this plugin is wired up correctly by inspection alone —
// this is the exact regression (dev mode never serving the landing page
// at all) that prompted writing it.
export function landingShellDevPlugin(): Plugin {
  return {
    name: 'landing-shell-dev',
    apply: 'serve',
    async transformIndexHtml(html, ctx) {
      const server = ctx.server
      if (!server) return html
      try {
        const mod = await server.ssrLoadModule('/src/prerenderEntry.tsx')
        const landingHtml = mod.renderLandingMarkup()
        const landingCss = await readFile(path.join(rootDir, 'src', 'landing.css'), 'utf8')
        return injectLandingShell(html, {
          landingHtml,
          landingCss,
          landingSeenKey: mod.LANDING_SEEN_KEY,
          appVisibleClass: mod.APP_VISIBLE_CLASS,
        })
      } catch (err) {
        // Fail toward the app still loading, never toward a broken dev
        // server — the same posture landing.ts's own storage calls take.
        // A typo in Landing.tsx should show up as a Vite overlay error
        // when the module itself loads, not as this plugin taking the
        // whole page down.
        console.error('[landing-shell-dev] could not inject the landing page:', err)
        return html
      }
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    landingShellDevPlugin(),
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
