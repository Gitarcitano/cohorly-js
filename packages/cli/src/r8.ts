const PG_MAP_ID_RE = /^#\s*pg_map_id:\s*(\S+)\s*$/;

export function parsePgMapId(mapping: string): string | null {
  for (const line of mapping.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    if (!line.startsWith("#")) return null;
    const match = PG_MAP_ID_RE.exec(line);
    if (match) return match[1]!;
  }
  return null;
}
