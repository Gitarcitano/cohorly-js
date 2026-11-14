// Session replay overhead benchmark (VEL-1782).
//
// Loads a local static page with the BUILT SDK (packages/sdk-core/dist,
// packages/sdk-web/dist, @rrweb/record) in headless Chromium, runs the same
// scripted interaction for DURATION_S seconds (typing into inputs, clicks that
// add list items, text mutations, mouse moves, scrolling) in five variants:
// no replay, session mode (sampleRate 1) and error mode (onErrorSampleRate 1,
// one captureException() at the end) on a page of about 1000 elements, and no
// replay / session mode on a page of about 5000 elements. It reports:
// - init cost: deltas of CDP Performance.getMetrics TaskDuration and
//   ScriptDuration from just before init() to 1.5 s after it (the replay
//   chunks' dynamic imports, rrweb's record() and its first full snapshot),
//   compared with init() without replay;
// - CPU: the same deltas over the interaction window ONLY, which starts 1 s
//   after init settled and ends when the scripted interaction ends. Page load,
//   init, the error send and the final flushes are outside it;
// - bytes per minute sent to POST /replay, on the wire (gzip) and raw
//   (decompressed), counted by a local mock API.
//
// Usage (from the repo root, after `pnpm --filter @cohorly/core build` and
// `pnpm --filter @cohorly/web build`, browsers from `pnpm --filter @cohorly/e2e browsers`):
//   node packages/sdk-web/bench/replay-overhead.mjs [--duration 60] [--runs 2]
// (5 variants x runs x about DURATION_S + 11 s each).
import { readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { cpus, platform, release, totalmem } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const DURATION_S = arg("duration", 60);
const RUNS = arg("runs", 2);
const VARIANTS = [
  { name: "off", replay: null, cards: 150 },
  { name: "session", replay: "session", cards: 150 },
  { name: "error", replay: "error", cards: 150 },
  { name: "off-5k", replay: null, cards: 800 },
  { name: "session-5k", replay: "session", cards: 800 },
];
const REPLAY_OPTIONS = {
  session: "{ sampleRate: 1 }",
  error: "{ sampleRate: 0, onErrorSampleRate: 1 }",
};

const require = createRequire(realpathSync(join(repo, "apps/e2e/node_modules/@playwright/test/package.json")));
const { chromium } = require("playwright-core");
const recordJs = join(
  dirname(realpathSync(join(repo, "packages/sdk-web/node_modules/@rrweb/record/package.json"))),
  "dist/record.js",
);

// ---- mock ingestion API: counts /replay bytes
let stats;
const resetStats = () => {
  stats = { requests: 0, wire: 0, raw: 0, events: 0, gzip: 0, keepalive: 0, errorChunks: 0 };
};
resetStats();
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
    const body = Buffer.concat(parts);
    if (url.pathname === "/replay") {
      const gzip = req.headers["content-encoding"] === "gzip" || url.searchParams.get("compression") === "gzip";
      const raw = gzip ? gunzipSync(body) : body;
      const chunk = JSON.parse(raw.toString());
      stats.requests += 1;
      stats.wire += body.length;
      stats.raw += raw.length;
      stats.events += chunk.events.length;
      if (gzip) stats.gzip += 1;
      if (url.searchParams.has("token")) stats.keepalive += 1;
      if (chunk.mode === "error") stats.errorChunks += 1;
    }
    res.writeHead(200, { ...cors, "content-type": "application/json" }).end('{"status":1}');
  });
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const API = `http://127.0.0.1:${api.address().port}`;

// ---- the page: about 1000 (150 cards) or 5000 (800 cards) elements and a
// scripted interaction driven by page timers; init() runs when the harness says.
const page = (replay, cards) => `<!doctype html><meta charset=utf-8><title>bench</title>
<style>body{font:14px system-ui;margin:16px}li{padding:2px}.card{border:1px solid #ccc;margin:4px;padding:4px}</style>
<script type="importmap">{"imports":{"@cohorly/core":"/core/index.js","@cohorly/web":"/web/index.js","@rrweb/record":"/rrweb/record.js"}}</script>
<h1>Checkout</h1>
<form><input id=name placeholder=Name><input id=email placeholder=Email><textarea id=notes></textarea><button type=button id=add>Add item</button></form>
<ul id=list></ul><div id=cards></div>
<script type="module">
  import { cohorly, init } from "@cohorly/web";
  const cards = document.getElementById("cards");
  for (let i = 0; i < ${cards}; i++) {
    const c = document.createElement("div");
    c.className = "card";
    c.innerHTML = "<b>Product " + i + "</b> <span class=price>$" + (i * 3) + "</span> <p>Lorem ipsum <em>dolor</em> sit amet, <a href=#>consectetur</a> adipiscing elit.</p>";
    cards.appendChild(c);
  }
  window.startSdk = () => init({ apiHost: "${API}", token: "bench", loadFeatureFlags: false, trackPageviews: true${
    replay ? `, sessionReplay: ${REPLAY_OPTIONS[replay]}` : ""
  } });
  window.captureError = () => cohorly.captureException(new Error("bench error"));
  window.elementCount = () => document.getElementsByTagName("*").length;
  const list = document.getElementById("list");
  document.getElementById("add").addEventListener("click", () => {
    const li = document.createElement("li");
    li.textContent = "Item " + list.children.length;
    list.appendChild(li);
    if (list.children.length > 200) list.firstChild.remove();
  });
  window.runInteraction = (ms) => new Promise((done) => {
    const text = "the quick brown fox jumps over the lazy dog ";
    const fields = ["name", "email", "notes"].map((id) => document.getElementById(id));
    let t = 0;
    const typing = setInterval(() => {
      const f = fields[Math.floor(t / 50) % 3];
      f.value += text[t % text.length];
      f.dispatchEvent(new Event("input", { bubbles: true }));
      t++;
    }, 100);
    const clicking = setInterval(() => document.getElementById("add").click(), 500);
    let m = 0;
    const mutating = setInterval(() => {
      for (const p of document.querySelectorAll(".price")) if (Math.random() < 0.1) p.textContent = "$" + (m++ % 999);
    }, 1000);
    const moving = setInterval(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: (m * 7) % 800, clientY: (m * 13) % 600, bubbles: true }));
      m++;
    }, 50);
    const scrolling = setInterval(() => window.scrollTo(0, (m * 37) % 2000), 2000);
    setTimeout(() => {
      for (const id of [typing, clicking, mutating, moving, scrolling]) clearInterval(id);
      done();
    }, ms);
  });
  window.ready = true;
</script>`;

const MIME = { ".js": "text/javascript", ".html": "text/html" };
const site = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/") {
    const replay = url.searchParams.get("replay") || null;
    const cards = Number(url.searchParams.get("cards") ?? 150);
    return void res.writeHead(200, { "content-type": "text/html" }).end(page(replay, cards));
  }
  if (url.pathname === "/rrweb/record.js") {
    return void res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(recordJs));
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

const browser = await chromium.launch();
const metric = (all, name) => all.metrics.find((x) => x.name === name)?.value ?? 0;

async function run(variant) {
  resetStats();
  const context = await browser.newContext();
  const p = await context.newPage();
  const cdp = await context.newCDPSession(p);
  await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
  await p.goto(`${ORIGIN}/?replay=${variant.replay ?? ""}&cards=${variant.cards}`);
  await p.waitForFunction(() => window.ready === true);
  await p.waitForTimeout(500);
  const elements = await p.evaluate(() => window.elementCount());
  const beforeInit = await cdp.send("Performance.getMetrics");
  await p.evaluate(() => window.startSdk());
  await p.waitForTimeout(1500); // dynamic imports, record(), first full snapshot
  const afterInit = await cdp.send("Performance.getMetrics");
  await p.waitForTimeout(1000);
  const before = await cdp.send("Performance.getMetrics");
  await p.evaluate((ms) => window.runInteraction(ms), DURATION_S * 1000);
  const after = await cdp.send("Performance.getMetrics");
  if (variant.replay === "error") await p.evaluate(() => window.captureError());
  await p.waitForTimeout(6000); // the 5 s chunk timer
  await p.close({ runBeforeUnload: true }); // pagehide: keepalive flush
  await new Promise((r) => setTimeout(r, 1000));
  await context.close();
  return {
    elements,
    initTaskS: metric(afterInit, "TaskDuration") - metric(beforeInit, "TaskDuration"),
    initScriptS: metric(afterInit, "ScriptDuration") - metric(beforeInit, "ScriptDuration"),
    taskS: metric(after, "TaskDuration") - metric(before, "TaskDuration"),
    scriptS: metric(after, "ScriptDuration") - metric(before, "ScriptDuration"),
    ...stats,
  };
}

const results = Object.fromEntries(VARIANTS.map((v) => [v.name, []]));
for (let i = 0; i < RUNS; i++) {
  for (const variant of VARIANTS) results[variant.name].push(await run(variant));
}
const avg = (list, key) => list.reduce((s, r) => s + r[key], 0) / list.length;
const minutes = DURATION_S / 60;
const fmt = (n, d = 3) => n.toFixed(d);

console.log(`machine: ${cpus()[0]?.model} x${cpus().length}, ${Math.round(totalmem() / 2 ** 30)} GB, ${platform()} ${release()}, node ${process.version}`);
console.log(`browser: chromium ${browser.version()} (headless, playwright-core)`);
console.log(`interaction: ${DURATION_S}s scripted (typing 10/s, click+append 2/s, text mutations 1/s, mousemove 20/s, scroll 0.5/s), ${RUNS} runs per variant`);
console.log("init window: from just before init() to 1.5 s after it (replay imports, record(), first full snapshot)");
console.log(`CPU window: the ${DURATION_S}s interaction only, starting 1 s after the init window; page load, init, the error send and the final flushes are outside it`);
for (const [name, list] of Object.entries(results)) {
  for (const [i, r] of list.entries()) {
    console.log(
      `${name} run ${i + 1}: elements ${r.elements} init Task ${fmt(r.initTaskS)}s Script ${fmt(r.initScriptS)}s | TaskDuration ${fmt(r.taskS)}s ScriptDuration ${fmt(r.scriptS)}s | replay requests ${r.requests} (gzip ${r.gzip}, keepalive ${r.keepalive}, error chunks ${r.errorChunks}) events ${r.events} wire ${r.wire} B raw ${r.raw} B`,
    );
  }
}
const compare = (base, name) => {
  const on = results[name];
  const off = results[base];
  const dTask = avg(on, "taskS") - avg(off, "taskS");
  const dScript = avg(on, "scriptS") - avg(off, "scriptS");
  const dInitTask = avg(on, "initTaskS") - avg(off, "initTaskS");
  const dInitScript = avg(on, "initScriptS") - avg(off, "initScriptS");
  console.log(`== ${name} vs ${base} (elements ${Math.round(avg(on, "elements"))})`);
  console.log(`avg ${base}: init Task ${fmt(avg(off, "initTaskS"))}s Script ${fmt(avg(off, "initScriptS"))}s | TaskDuration ${fmt(avg(off, "taskS"))}s ScriptDuration ${fmt(avg(off, "scriptS"))}s`);
  console.log(`avg ${name}: init Task ${fmt(avg(on, "initTaskS"))}s Script ${fmt(avg(on, "initScriptS"))}s | TaskDuration ${fmt(avg(on, "taskS"))}s ScriptDuration ${fmt(avg(on, "scriptS"))}s`);
  console.log(`init cost: +${fmt(dInitTask)}s task, +${fmt(dInitScript)}s script`);
  console.log(
    `interaction CPU overhead: +${fmt(dTask)}s main-thread task time over ${DURATION_S}s (${fmt((dTask / DURATION_S) * 100, 2)}% of wall time), +${fmt(dScript)}s script`,
  );
  console.log(
    `replay bytes/min: wire ${fmt(avg(on, "wire") / minutes / 1024, 1)} KiB (gzip), raw ${fmt(avg(on, "raw") / minutes / 1024, 1)} KiB, compression ${fmt(avg(on, "raw") / Math.max(1, avg(on, "wire")), 1)}x, ${fmt(avg(on, "requests"), 1)} requests, ${fmt(avg(on, "events"), 0)} events`,
  );
};
compare("off", "session");
compare("off", "error");
compare("off-5k", "session-5k");

await browser.close();
api.close();
site.close();
