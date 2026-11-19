import { AnyMap, decodedMappings, originalPositionFor, type TraceMap } from "@jridgewell/trace-mapping";
import type { DecodedMap, Segment } from "./index-format.js";

type RawMap = string | Record<string, unknown>;

function traceMap(map: RawMap): TraceMap {
  return new AnyMap(map as ConstructorParameters<typeof AnyMap>[0]);
}

export function decodeSourceMap(map: RawMap): DecodedMap {
  const tm = traceMap(map);
  return { sources: tm.resolvedSources, names: tm.names, mappings: decodedMappings(tm) };
}

export function composeHermes(packagerMap: RawMap, hermesMap: RawMap): DecodedMap {
  const packager = traceMap(packagerMap);
  const hermes = decodedMappings(traceMap(hermesMap));
  const sources: string[] = [];
  const sourceIds = new Map<string, number>();
  const names: string[] = [];
  const nameIds = new Map<string, number>();
  const intern = (table: string[], ids: Map<string, number>, value: string) => {
    let id = ids.get(value);
    if (id === undefined) {
      id = table.length;
      table.push(value);
      ids.set(value, id);
    }
    return id;
  };

  const mappings: Segment[][] = hermes.map((line) => {
    const out: Segment[] = [];
    for (const segment of line) {
      if (segment.length < 4) {
        out.push([segment[0]!]);
        continue;
      }
      const original = originalPositionFor(packager, { line: segment[2]! + 1, column: segment[3]! });
      if (original.source === null || original.line === null || original.column === null) {
        out.push([segment[0]!]);
        continue;
      }
      const sourceId = intern(sources, sourceIds, original.source);
      out.push(
        original.name === null
          ? [segment[0]!, sourceId, original.line - 1, original.column]
          : [segment[0]!, sourceId, original.line - 1, original.column, intern(names, nameIds, original.name)],
      );
    }
    return out;
  });
  return { sources, names, mappings };
}
