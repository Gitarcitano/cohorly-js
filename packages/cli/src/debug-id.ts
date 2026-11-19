import { createHash } from "node:crypto";

export const DEBUG_ID_NAMESPACE = "6f3b2a1e-8c4d-5e7f-9a0b-c1d2e3f4a5b6";

const DEBUG_ID_RE = /^\/\/# debugId=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})[ \t]*$/m;
const SOURCE_MAPPING_URL_RE = /^\/\/[#@] sourceMappingURL=.*$/gm;

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function uuidV5(name: Uint8Array | string, namespace: string = DEBUG_ID_NAMESPACE): string {
  const hash = createHash("sha1")
    .update(uuidBytes(namespace))
    .update(typeof name === "string" ? Buffer.from(name, "utf8") : name)
    .digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return formatUuid(bytes);
}

export function debugIdFor(bundle: Uint8Array | string, mapJson?: string): string {
  const bundleBytes = typeof bundle === "string" ? Buffer.from(bundle, "utf8") : Buffer.from(bundle);
  if (mapJson === undefined) return uuidV5(bundleBytes);
  const map = JSON.parse(mapJson) as Record<string, unknown>;
  delete map.debugId;
  delete map.debug_id;
  return uuidV5(Buffer.concat([bundleBytes, Buffer.from([0]), Buffer.from(JSON.stringify(map), "utf8")]));
}

export function readDebugIdComment(source: string): string | null {
  const match = DEBUG_ID_RE.exec(source);
  return match ? match[1]!.toLowerCase() : null;
}

export function injectDebugIdComment(source: string, debugId: string): string {
  const comment = `//# debugId=${debugId}\n`;
  let lastIndex = -1;
  let lastEnd = -1;
  for (const match of source.matchAll(SOURCE_MAPPING_URL_RE)) {
    lastIndex = match.index ?? lastIndex;
    lastEnd = lastIndex + match[0].length;
  }
  if (lastIndex >= 0 && source.slice(lastEnd).trim() === "") {
    return source.slice(0, lastIndex) + comment + source.slice(lastIndex);
  }
  const separator = source.length === 0 || source.endsWith("\n") ? "" : "\n";
  return source + separator + comment;
}

export function readMapDebugId(map: Record<string, unknown>): string | null {
  const value = map.debugId ?? map.debug_id;
  return typeof value === "string" && value.length > 0 ? value.toLowerCase() : null;
}

export interface InjectResult {
  debugId: string;
  source: string | null;
  map: string | null;
}

export function injectDebugId(source: string, mapJson: string): InjectResult {
  const map = JSON.parse(mapJson) as Record<string, unknown>;
  const existing = readDebugIdComment(source);
  const debugId = existing ?? debugIdFor(source, mapJson);
  const nextSource = existing ? null : injectDebugIdComment(source, debugId);
  let nextMap: string | null = null;
  if (readMapDebugId(map) !== debugId || map.debugId === undefined) {
    map.debugId = debugId;
    nextMap = JSON.stringify(map);
  }
  return { debugId, source: nextSource, map: nextMap };
}
