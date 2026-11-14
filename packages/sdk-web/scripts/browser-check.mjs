// Real-browser check for VEL-1789: frames order (ADR-0019), XHR breadcrumbs, sendBeacon on close.
// Real HTTP servers (page on one port, mock ingestion API on another), no request interception.
// Usage: node packages/sdk-web/scripts/browser-check.mjs <repoRoot> <firefox|webkit|chromium>
// Needs the packages built (pnpm --filter @cohorly/web build) and the browsers installed
// (apps/e2e/node_modules/.bin/playwright install firefox webkit).
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join } from "node:path";

const [repo, browserName] = process.argv.slice(2);
const require = createRequire(realpathSync(join(repo, "apps/e2e/node_modules/@playwright/test/package.json")));
const pw = require("playwright-core");
const MIME = { ".js": "text/javascript", ".html": "text/html" };

const received = []; // POST /track: { raw, ct }
let blockTrack = false;

const api = createServer((req, res) => {
  const cors = {
    "access-control-allow-origin": req.headers.origin ?? "*",
    "access-control-allow-headers": "content-type, x-cohorly-token, authorization",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors).end();
    return;
  }
  const path = new URL(req.url, "http://x").pathname;
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (path === "/track" && req.method === "POST") {
      if (blockTrack) {
        req.socket.destroy(); // a network failure, the page keeps the exception queued
        return;
      }
      received.push({ raw, ct: req.headers["content-type"] ?? "" });
      res.writeHead(200, { ...cors, "content-type": "application/json" }).end('{"status":1,"inserted":1}');
      return;
    }
    if (path.startsWith("/fail")) return void res.writeHead(500, cors).end("no");
    res.writeHead(200, cors).end("{}");
  });
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const API = `http://127.0.0.1:${api.address().port}`;

const HTML = `<!doctype html><meta charset=utf-8><title>t</title>
<script type="importmap">{"imports":{"@cohorly/core":"/core/index.js","@cohorly/web":"/web/index.js"}}</script>
<script type="module">
  import { init, cohorly } from "@cohorly/web";
  const q = new URLSearchParams(location.search);
  window.__beacons = JSON.parse(localStorage.getItem("__beacons") || "[]");
  const orig = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = (url, data) => {
    const r = orig(url, data);
    window.__beacons.push({ url, accepted: r });
    localStorage.setItem("__beacons", JSON.stringify(window.__beacons));
    return r;
  };
  init({ apiHost: "${API}", token: "tok", loadFeatureFlags: false, captureExceptions: true,
         flushIntervalMs: Number(q.get("interval") || 100), release: "1.0.0" });
  window.cohorly = cohorly;
  function a() { b(); }
  function b() { c(); }
  function c() { throw new Error("verification crash"); }
  window.startCrash = () => setTimeout(a, 0);
  window.fatalLater = (msg) => setTimeout(() => { throw new Error(msg); }, 0);
  window.ready = true;
</script>`;

const site = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/") return void res.writeHead(200, { "content-type": "text/html" }).end(HTML);
  if (path === "/blank.html") return void res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>b</title>");
  const m = /^\/(core|web)\/([\w./-]+)$/.exec(path);
  if (!m) return void res.writeHead(404).end();
  try {
    const dir = m[1] === "core" ? "packages/sdk-core/dist" : "packages/sdk-web/dist";
    if (m[2].includes("..")) throw new Error("bad path");
    const body = await readFile(join(repo, dir, m[2]));
    res.writeHead(200, { "content-type": MIME[extname(m[2])] ?? "text/plain" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${site.address().port}`;

const fail = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} [${browserName}] ${name}${detail ? " - " + detail : ""}`);
  if (!ok) fail.push(name);
};
const exceptions = (value) =>
  received.flatMap((r) => {
    try {
      const body = JSON.parse(r.raw);
      const list = Array.isArray(body) ? body : (body.batch ?? body.events ?? [body]);
      return list.filter((e) => e.event === "$exception" && e.properties.$exception_list?.[0]?.value === value).map((e) => ({ ...e, ct: r.ct }));
    } catch {
      return [];
    }
  });

const browser = await pw[browserName].launch();
const context = await browser.newContext();

// ---- 1. frames order + XHR breadcrumbs through an unhandled error
const page = await context.newPage();
await page.goto(`${ORIGIN}/`);
await page.waitForFunction(() => window.ready === true);
await page.evaluate(async (apiBase) => {
  const xhr = (method, url) =>
    new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.open(method, url);
      x.onloadend = () => resolve();
      x.send();
    });
  await xhr("GET", `${apiBase}/fail500?secret=1#frag`);
  await xhr("GET", `${apiBase}/ok`);
  await xhr("POST", `${apiBase}/track`);
  // The app's own onload throws because of the 5xx: the SDK's breadcrumb must already be there.
  await new Promise((resolve) => {
    const x = new XMLHttpRequest();
    x.open("GET", `${apiBase}/fail503`);
    x.onload = () => {
      setTimeout(resolve, 0);
      throw new Error("app onload failed");
    };
    x.send();
  });
  // Same with the DONE readystatechange, which fires before load.
  await new Promise((resolve) => {
    const x = new XMLHttpRequest();
    x.open("GET", `${apiBase}/fail504`);
    x.onreadystatechange = () => {
      if (x.readyState !== 4) return;
      setTimeout(resolve, 0);
      throw new Error("app readystatechange failed");
    };
    x.send();
  });
  window.startCrash();
}, API);
await page.waitForTimeout(1500);
const ex = exceptions("verification crash");
check("one unhandled error reaches /track as one $exception", ex.length === 1, `got ${ex.length}`);
if (ex[0]) {
  const p = ex[0].properties;
  const frames = p.$exception_list[0].stacktrace?.frames ?? [];
  const names = frames.map((f) => f.function).filter(Boolean);
  console.log(`  frames: ${JSON.stringify(frames.map((f) => `${f.function}:${f.lineno}:${f.colno}`))}`);
  check("frames oldest first, crashing frame last (ADR-0019)", names.join(">") === "a>b>c", names.join(" > "));
  check("level is fatal and mechanism onerror", p.$exception_level === "fatal" && p.$exception_list[0].mechanism?.type === "onerror");
  const crumbs = (p.$exception_breadcrumbs ?? []).filter((c) => c.category === "xhr");
  console.log(`  xhr breadcrumbs: ${JSON.stringify(crumbs.map((c) => c.message))}`);
  check("XHR 500 recorded without query or hash", crumbs.some((c) => c.message === `GET ${API}/fail500 500` && !JSON.stringify(c).includes("secret") && !JSON.stringify(c).includes("frag")));
  check("XHR 200 and the SDK's own /track XHR not recorded", crumbs.length === 3, `${crumbs.length} xhr crumbs`);
}
const onstate = exceptions("app readystatechange failed");
const onstateCrumbs = (onstate[0]?.properties.$exception_breadcrumbs ?? []).filter((c) => c.category === "xhr").map((c) => c.message);
check("breadcrumb is already recorded when the app's onreadystatechange throws on DONE", onstate.length === 1 && onstateCrumbs.includes(`GET ${API}/fail504 500`), JSON.stringify(onstateCrumbs));
const onload = exceptions("app onload failed");
const onloadCrumbs = (onload[0]?.properties.$exception_breadcrumbs ?? []).filter((c) => c.category === "xhr").map((c) => c.message);
check("breadcrumb of a failed request is already recorded when the app's own onload throws", onload.length === 1 && onloadCrumbs.some((m) => m === `GET ${API}/fail503 500`) , JSON.stringify(onloadCrumbs));
await page.close();

// ---- 2. fatal queued while fetch fails, tab leaves: it goes out by sendBeacon
async function closeScenario(message, leave) {
  received.length = 0;
  blockTrack = true;
  const p = await context.newPage();
  await p.goto(`${ORIGIN}/?interval=600000`);
  await p.waitForFunction(() => window.ready === true);
  await p.evaluate(() => {
    localStorage.removeItem("__beacons");
    window.__beacons = [];
  });
  await p.evaluate((m) => window.fatalLater(m), message);
  await p.waitForTimeout(800);
  const before = received.length;
  blockTrack = false;
  await leave(p);
  await new Promise((r) => setTimeout(r, 1500));
  return { before, got: exceptions(message) };
}
let r = await closeScenario("fatal before close", async (p) => {
  await p.goto(`${ORIGIN}/blank.html`); // same-origin navigation fires pagehide, like leaving the tab
});
check("nothing reached /track while the fatal was queued", r.before === 0, `${r.before} bodies`);
check("fatal $exception arrived once after pagehide navigation", r.got.length === 1, `got ${r.got.length}, content-type ${r.got[0]?.ct}`);
const beacons = await (async () => {
  const p = await context.newPage();
  await p.goto(`${ORIGIN}/blank.html`);
  const v = await p.evaluate(() => JSON.parse(localStorage.getItem("__beacons") || "[]"));
  await p.close();
  return v;
})();
check("it left through navigator.sendBeacon (accepted)", beacons.length > 0 && beacons.every((b) => b.accepted), JSON.stringify(beacons));

r = await closeScenario("fatal at tab close", async (p) => {
  await p.close();
});
check("page.close(): nothing reached /track before, fatal arrived once after", r.before === 0 && r.got.length === 1, `before ${r.before}, got ${r.got.length}`);

await browser.close();
api.close();
site.close();
if (fail.length) {
  console.log(`FAILED: ${fail.join("; ")}`);
  process.exit(1);
}
