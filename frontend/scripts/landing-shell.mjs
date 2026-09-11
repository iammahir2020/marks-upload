// Shared by scripts/prerender-landing.mjs (the real `npm run build` output)
// and vite.config.ts's dev-mode plugin (`vite dev`/`./dev.sh`). Both need to
// produce byte-identical injected markup — a static shell that behaves one
// way in production and a different way in dev would defeat the point of
// testing the landing page locally before it ships. Kept dependency-free
// (no React here) so it can be imported from vite.config.ts without pulling
// react-dom/server into the config loader.

// ~15 lines, per plan.md §19. Reads LANDING_SEEN_KEY/APP_VISIBLE_CLASS as
// literals embedded at generation time — this text has to run before any
// bundle exists to import those from.
export function buildBootstrapScript(landingSeenKey, appVisibleClass) {
  const key = JSON.stringify(landingSeenKey);
  const cls = JSON.stringify(appVisibleClass);
  return `(function(){
  var KEY=${key},CLS=${cls},html=document.documentElement;
  try{if(localStorage.getItem(KEY)==='1')html.classList.add(CLS);}
  catch(e){html.classList.add(CLS);}
  document.addEventListener('click',function(e){
    var t=e.target.closest&&e.target.closest('[data-open-app]');
    if(!t)return;
    try{localStorage.setItem(KEY,'1');}catch(e2){}
    html.classList.add(CLS);
  });
})();`;
}

// Injects the static landing markup, its critical CSS, and the bootstrap
// script into an already-built (or dev-server-served) index.html, outside
// #root. Throws rather than silently no-opping if either marker is
// missing — a build that silently ships an empty shell while every
// component test still passes is exactly the failure mode plan.md §19
// names, and staying silent here would let a future index.html edit
// reintroduce it unnoticed.
export function injectLandingShell(html, { landingHtml, landingCss, landingSeenKey, appVisibleClass }) {
  const styleTag = `<style id="lp-critical-css">${landingCss}</style>`;
  const scriptTag = `<script id="lp-bootstrap">${buildBootstrapScript(landingSeenKey, appVisibleClass)}</script>`;

  if (!html.includes('</head>')) throw new Error('injectLandingShell: no </head> found');
  let out = html.replace('</head>', `${styleTag}${scriptTag}</head>`);

  const rootDiv = '<div id="root"></div>';
  if (!out.includes(rootDiv)) throw new Error('injectLandingShell: no #root div found');
  out = out.replace(rootDiv, `<div id="landing-root">${landingHtml}</div>${rootDiv}`);

  return out;
}
