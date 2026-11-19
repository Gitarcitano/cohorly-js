import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { addSegment, GenMapping, setSourceContent, toEncodedMap } from "@jridgewell/gen-mapping";
import type { Io } from "../src/cli.js";
import type { SymcacheBuilder, SymcacheSliceResult } from "../src/symcache/macho.js";

export const SOURCES_CONTENT_MARKER = "SOURCES_CONTENT_MARKER_9f2c4e71";

type Seg = [number] | [number, string, number, number] | [number, string, number, number, string];

export function encodedMap(lines: Seg[][], options: { file?: string; sourceRoot?: string; withContent?: boolean } = {}) {
  const map = new GenMapping({ file: options.file, sourceRoot: options.sourceRoot });
  lines.forEach((segments, line) => {
    for (const seg of segments) {
      if (seg.length === 1) addSegment(map, line, seg[0]);
      else if (seg.length === 4) addSegment(map, line, seg[0], seg[1], seg[2], seg[3]);
      else addSegment(map, line, seg[0], seg[1], seg[2], seg[3], seg[4]);
    }
  });
  const encoded = toEncodedMap(map);
  if (options.withContent !== false) {
    for (const source of encoded.sources) {
      if (source) setSourceContent(map, source, `// ${SOURCES_CONTENT_MARKER} ${source}\nexport const x = 1;\n`);
    }
  }
  return JSON.parse(JSON.stringify(toEncodedMap(map))) as Record<string, unknown> & { mappings: string; sources: string[] };
}

export function fixtureMap() {
  return encodedMap(
    [
      [[0, "a.ts", 0, 0, "main"], [5], [10, "b.ts", 3, 4], [10, "a.ts", 9, 9, "shadowed"], [20, "b.ts", 7, 0, "helper"], [20, "c.ts", 1, 1]],
      [],
      [[4, "c.ts", 1, 2], [8, "a.ts", 2, 0, "main"], [15, "b.ts", 2, 2, "helper"]],
      [[0]],
      [],
      [[3, "b.ts", 0, 0, "x"], [9], [12, "c.ts", 4, 8]],
    ],
    { file: "app.js", sourceRoot: "src/" },
  );
}

export function hermesPair() {
  const packager = encodedMap(
    [
      [
        [0, "src/App.tsx", 9, 2, "onPress"],
        [30, "src/App.tsx", 19, 4, "render"],
      ],
      [[0]],
    ],
    { file: "index.android.bundle" },
  );
  const hermes = encodedMap(
    [
      [
        [100, "index.android.bundle", 0, 5, "anonymous"],
        [200, "index.android.bundle", 0, 35],
        [300, "index.android.bundle", 1, 0],
        [400, "index.android.bundle", 7, 0],
      ],
    ],
    { file: "index.android.bundle.hbc", withContent: false },
  );
  return { packager, hermes };
}

export function randomMap(seed: number, lineCount: number) {
  let state = seed;
  const next = (max: number) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state % max;
  };
  const sources = ["webpack:///./src/index.ts", "../lib/util.js", "pages/home.tsx", "node_modules/react/index.js"];
  const names = ["render", "useState", "onClick", "a", "b"];
  const lines: Seg[][] = [];
  for (let l = 0; l < lineCount; l++) {
    const line: Seg[] = [];
    let col = next(3);
    const count = next(4) === 0 ? 0 : next(12);
    for (let i = 0; i < count; i++) {
      const kind = next(5);
      if (kind === 0) line.push([col]);
      else if (kind === 1) line.push([col, sources[next(sources.length)]!, next(200), next(80)]);
      else line.push([col, sources[next(sources.length)]!, next(200), next(80), names[next(names.length)]!]);
      if (next(4) !== 0) col += 1 + next(40);
    }
    lines.push(line);
  }
  return encodedMap(lines, { file: "bundle.js" });
}

export async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "cohorly-cli-"));
}

export async function writeFiles(root: string, files: Record<string, string | Uint8Array>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}

export interface Received {
  method: string;
  pathname: string;
  query: Record<string, string>;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export type Responder = (req: Received, n: number) => { status: number; body?: unknown; headers?: Record<string, string> };

export async function startServer(responder: Responder = () => ({ status: 201, body: { id: "sym_1" } })) {
  const requests: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://localhost");
      const received: Received = {
        method: req.method ?? "",
        pathname: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw,
      };
      requests.push(received);
      const out = responder(received, requests.length);
      res.writeHead(out.status, { "content-type": "application/json", ...out.headers });
      res.end(JSON.stringify(out.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function makeIo(env: Record<string, string | undefined>, extra: Partial<Io> = {}) {
  const out = { stdout: "", stderr: "" };
  const sleeps: number[] = [];
  const io: Io = {
    env,
    stdout: (t) => {
      out.stdout += t;
    },
    stderr: (t) => {
      out.stderr += t;
    },
    fetch: globalThis.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  };
  return { io, out, sleeps };
}

/** A symcache builder keyed by DWARF file basename: slices, or an Error to throw. */
export function fakeSymcache(results: Record<string, SymcacheSliceResult[] | Error>, available = true) {
  const built: string[] = [];
  const builder: SymcacheBuilder = {
    async build(file) {
      built.push(file);
      const r = results[path.basename(file)];
      if (r instanceof Error) throw r;
      return r ?? [];
    },
    async available() {
      return available;
    },
  };
  return { builder, built };
}
