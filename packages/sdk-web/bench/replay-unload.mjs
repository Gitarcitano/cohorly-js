// Session replay unload check (VEL-1870): what reaches POST /replay when the
// tab is closed right after a large full snapshot, in the browser of your
// choice. Two runs of the same page with the BUILT SDK (packages/sdk-core/dist,
// packages/sdk-web/dist, @rrweb/record) against a local mock API:
// - baseline: the tab stays open past the 5 s chunk timer, so the snapshot is
//   sent by the regular request. Gives the size of the snapshot chunk.
// - unload: the tab is closed 1.5 s after init(), before the timer, so the only
//   way out is the `pagehide` keepalive flush (a 63 KiB budget per page).
// It reports the requests the mock API received in each run: transport
// (`?token=` in the URL marks a keepalive request), wire and raw bytes, events,
// and whether a full snapshot (rrweb event type 2) arrived.
//
// Usage (repo root, after `pnpm --filter @cohorly/core build` and
// `pnpm --filter @cohorly/web build`; Chromium via `pnpm --filter @cohorly/e2e browsers`, the others via
// `pnpm exec playwright install firefox webkit`; WebKit on a host without its system
// libraries runs in the `mcr.microsoft.com/playwright:v<version>-noble` image):
//   node packages/sdk-web/bench/replay-unload.mjs [--browser chromium|firefox|webkit] [--cards 3000] [--medium-cards 600] [--repeats 3] [--console 300] [--network 10]
// "console unload" (VEL-2144) is the medium run plus `--console` lines (default 300) of 1 KiB random
// hex logged 0.5 s after init, competing with the snapshot for the keepalive budget.
// "network unload" (VEL-2145) is the medium run with `sessionReplay.network`
// (headers and bodies of the page's own origin) and `--network` fetches
// (default 10) of 64 KiB of barely compressible JSON 0.5 s after init, so each
// `$network` event carries a 16 KiB body competing for the keepalive budget.
// "medium unload" (VEL-2156) closes the SDK page with a mid-size snapshot
// (600 cards, about 3,600 elements). Besides those runs it adds two controls, because a missing request
// on close has more than one possible cause: "control" closes a page that only
// sends a minimal synchronous `fetch(..., { keepalive: true })` from `pagehide`
// (does this harness deliver any keepalive at all?), and "small unload" closes
// the SDK page with a tiny snapshot (does the loss depend on the snapshot size?).
import { readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { platform, release } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const BROWSER = flag("browser", process.env.BENCH_BROWSER || "chromium");
const CARDS = Number(flag("cards", 3000));
const SMALL_CARDS = 10;
const MEDIUM_CARDS = Number(flag("medium-cards", 600));
const REPEATS = Number(flag("repeats", 3));

const require = createRequire(realpathSync(join(repo, "apps/e2e/node_modules/@playwright/test/package.json")));
const playwright = require("playwright-core");
const browserType = playwright[BROWSER];
if (!browserType) throw new Error(`unknown browser "${BROWSER}" (chromium, firefox or webkit)`);
const recordJs = join(
  dirname(realpathSync(join(repo, "packages/sdk-web/node_modules/@rrweb/record/package.json"))),
  "dist/record.js",
);
// The SDK build keeps `import "fflate"` (keepalive gzip): serve its browser ESM build.
const fflateJs = join(
  dirname(createRequire(join(repo, "packages/sdk-web/package.json")).resolve("fflate/package.json")),
  "esm/browser.js",
);

const received = [];
const api = createServer((req, res) => {
  const cors = {
    "access-control-allow-origin": req.headers.origin ?? "*",
    "access-control-allow-headers": "content-type, content-encoding, x-cohorly-token",
    "access-control-allow-methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") return void res.writeHead(204, cors).end();
  const url = new URL(req.url, "http://x");
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => {
    const rid = url.searchParams.get("token") ?? req.headers["x-cohorly-token"];
    if (url.pathname === "/replay" && url.searchParams.has("control")) {
      received.push({ rid, control: true });
    } else if (url.pathname === "/replay") {
      const body = Buffer.concat(parts);
      const gzip = req.headers["content-encoding"] === "gzip" || url.searchParams.get("compression") === "gzip";
      const raw = gzip ? gunzipSync(body) : body;
      const chunk = JSON.parse(raw.toString());
      received.push({
        rid,
        keepalive: url.searchParams.has("token"),
        gzip,
        wire: body.length,
        raw: raw.length,
        seq: chunk.seq,
        events: chunk.events.length,
        fullSnapshot: chunk.events.some((e) => e.type === 2),
      });
    }
    res.writeHead(200, { ...cors, "content-type": "application/json" }).end('{"status":1}');
  });
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const API = `http://127.0.0.1:${api.address().port}`;

const page = `<!doctype html><meta charset=utf-8><title>unload</title>
<script type="importmap">{"imports":{"@cohorly/core":"/core/index.js","@cohorly/web":"/web/index.js","@rrweb/record":"/rrweb/record.js","fflate":"/fflate/browser.js"}}</script>
<h1>Checkout</h1><div id=cards></div>
<script type="module">
  import { init } from "@cohorly/web";
  const cards = document.getElementById("cards");
  const params = new URLSearchParams(location.search);
  const count = Number(params.get("cards") ?? ${CARDS});
  const rid = params.get("rid");
  if (params.has("control")) {
    addEventListener("pagehide", () => {
      fetch("${API}/replay?token=" + rid + "&control=1", { method: "POST", keepalive: true, body: "{}" });
    });
  }
  for (let i = 0; i < count; i++) {
    const c = document.createElement("div");
    c.innerHTML = "<b>Product " + i + "</b> <span>$" + (i * 3) + "</span> <p>Lorem ipsum <em>dolor</em> sit amet, <a href=#>consectetur</a> adipiscing elit " + i + ".</p>";
    cards.appendChild(c);
  }
  window.elementCount = () => document.getElementsByTagName("*").length;
  // VEL-2144: \`console=N\` logs N lines of 1 KiB random hex (barely compressible) 0.5 s after init.
  const noise = () => Array.from(crypto.getRandomValues(new Uint8Array(512)), (b) => b.toString(16).padStart(2, "0")).join("");
  window.startSdk = () => {
    if (params.has("control")) return null;
    const fetches = Number(params.get("network") ?? 0);
    const network = fetches > 0 ? { headers: true, bodies: true, allowUrls: [location.origin + "/"] } : undefined;
    init({ apiHost: "${API}", token: rid, loadFeatureFlags: false, trackPageviews: true, sessionReplay: { sampleRate: 1, network } });
    if (fetches > 0) setTimeout(() => { for (let i = 0; i < fetches; i++) fetch("/big?i=" + i).then((r) => r.json()); }, 500);
    const lines = Number(params.get("console") ?? 0);
    if (lines > 0) setTimeout(() => { for (let i = 0; i < lines; i++) console.log("line", i, noise()); }, 500);
  };
  window.ready = true;
</script>`;

const MIME = { ".js": "text/javascript", ".html": "text/html" };
const site = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/") return void res.writeHead(200, { "content-type": "text/html" }).end(page);
  if (url.pathname === "/big") {
    const hex = Array.from({ length: 64 * 1024 / 2 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0")).join("");
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: hex.slice(0, 64 * 1024 - 12) }));
  }
  if (url.pathname === "/rrweb/record.js") {
    return void res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(recordJs));
  }
  if (url.pathname === "/fflate/browser.js") {
    return void res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(fflateJs));
  }
  const m = /^\/(core|web)\/([\w./-]+)$/.exec(url.pathname);
  if (!m || m[2].includes("..")) return void res.writeHead(404).end();
  try {
    const dir = m[1] === "core" ? "packages/sdk-core/dist" : "packages/sdk-web/dist";
    res.writeHead(200, { "content-type": MIME[extname(m[2])] ?? "text/plain" }).end(readFileSync(join(repo, dir, m[2])));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${site.address().port}`;

const browser = await browserType.launch();
console.log(`browser: ${BROWSER} ${browser.version()} (headless, playwright-core), ${platform()} ${release()}, node ${process.version}`);

// Every run has its own token, so a request that lands after its page closed
// (WebKit delivers late) is still counted for the run that sent it.
const runs = [];
async function run(name, closeAfterMs, query = "") {
  const rid = `r${runs.length}`;
  const context = await browser.newContext();
  const p = await context.newPage();
  await p.goto(`${ORIGIN}/?rid=${rid}${query}`);
  await p.waitForFunction(() => window.ready === true);
  const elements = await p.evaluate(() => window.elementCount());
  await p.evaluate(() => window.startSdk());
  await p.waitForTimeout(closeAfterMs);
  await p.close({ runBeforeUnload: true });
  // Closing the context at once cancels the keepalive requests still in flight in Chromium.
  await new Promise((r) => setTimeout(r, 2500));
  await context.close();
  runs.push({ name, rid, elements });
}

const sum = (list, key) => list.reduce((s, r) => s + (r[key] ?? 0), 0);
const report = ({ name, rid, elements }) => {
  const mine = received.filter((r) => r.rid === rid);
  const control = mine.filter((r) => r.control).length;
  const sent = mine.filter((r) => !r.control);
  console.log(`${name}: elements ${elements}, requests ${sent.length}, wire ${sum(sent, "wire")} B, raw ${sum(sent, "raw")} B, events ${sum(sent, "events")}, full snapshot received ${sent.some((r) => r.fullSnapshot)}${control ? `, control keepalive requests ${control}` : ""}`);
  for (const r of sent) {
    console.log(`  seq ${r.seq}: ${r.keepalive ? "keepalive" : "regular"}, gzip ${r.gzip}, wire ${r.wire} B, raw ${r.raw} B, events ${r.events}, full snapshot ${r.fullSnapshot}`);
  }
};

await run("baseline (tab open past the 5 s timer)", 6500);
for (let i = 1; i <= REPEATS; i++) await run(`unload ${i}/${REPEATS} (tab closed 1.5 s after init)`, 1500);
for (let i = 1; i <= REPEATS; i++) await run(`medium unload ${i}/${REPEATS} (${MEDIUM_CARDS} cards, tab closed 1.5 s after init)`, 1500, `&cards=${MEDIUM_CARDS}`);
for (let i = 1; i <= REPEATS; i++) await run(`control ${i}/${REPEATS} (minimal sync keepalive fetch in pagehide, no SDK)`, 1500, "&control=1&cards=10");
const CONSOLE_LINES = Number(flag("console", 300));
for (let i = 1; i <= REPEATS; i++) await run(`console unload ${i}/${REPEATS} (${MEDIUM_CARDS} cards, ${CONSOLE_LINES} console lines of 1 KiB, tab closed 1.5 s after init)`, 1500, `&cards=${MEDIUM_CARDS}&console=${CONSOLE_LINES}`);
const NETWORK_FETCHES = Number(flag("network", 10));
for (let i = 1; i <= REPEATS; i++) await run(`network unload ${i}/${REPEATS} (${MEDIUM_CARDS} cards, network option on, ${NETWORK_FETCHES} fetches of 64 KiB JSON, tab closed 1.5 s after init)`, 1500, `&cards=${MEDIUM_CARDS}&network=${NETWORK_FETCHES}`);
for (let i = 1; i <= REPEATS; i++) await run(`small unload ${i}/${REPEATS} (${SMALL_CARDS} cards, tab closed 1.5 s after init)`, 1500, `&cards=${SMALL_CARDS}`);

await new Promise((r) => setTimeout(r, 8000)); // late arrivals
for (const r of runs) report(r);

await browser.close();
api.close();
site.close();
