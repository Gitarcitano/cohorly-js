// The import report: counts per (UTC day, reason). An empty reason is the
// events the server accepted (inserted or matched as duplicates); any other
// reason is a refusal, from the server (`older_than_retention`, ...) or local
// (`invalid_json`, `event_too_large`). Each non-blank input line lands in
// exactly one row, so the `read` column sums to the lines read.

export const UNKNOWN_DAY = "unknown";
export const CSV_HEADER = "day,reason,read,inserted,duplicates,refused";

export interface ReportCounts {
  read: number;
  inserted: number;
  duplicates: number;
  refused: number;
}

export interface ReportRow extends ReportCounts {
  day: string;
  reason: string;
}

const COUNT_KEYS = ["read", "inserted", "duplicates", "refused"] as const;

function compareRows(a: ReportRow, b: ReportRow): number {
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  if (a.reason !== b.reason) return a.reason < b.reason ? -1 : 1;
  return 0;
}

export class ImportReport {
  private readonly rows = new Map<string, ReportRow>();

  add(day: string, reason: string, counts: Partial<ReportCounts>): void {
    const key = JSON.stringify([day, reason]);
    let row = this.rows.get(key);
    if (!row) {
      row = { day, reason, read: 0, inserted: 0, duplicates: 0, refused: 0 };
      this.rows.set(key, row);
    }
    for (const k of COUNT_KEYS) row[k] += counts[k] ?? 0;
  }

  /** Events the server stored (`inserted`) or already had (`duplicates`). */
  accepted(day: string, inserted: number, duplicates: number): void {
    this.add(day, "", { read: inserted + duplicates, inserted, duplicates });
  }

  refusal(day: string, reason: string, count = 1): void {
    this.add(day, reason, { read: count, refused: count });
  }

  merge(other: ImportReport): void {
    for (const row of other.toRows()) this.add(row.day, row.reason, row);
  }

  totals(): ReportCounts {
    const total: ReportCounts = { read: 0, inserted: 0, duplicates: 0, refused: 0 };
    for (const row of this.rows.values()) for (const k of COUNT_KEYS) total[k] += row[k];
    return total;
  }

  /** Rows sorted by day, then reason (accepted first). */
  toRows(): ReportRow[] {
    return [...this.rows.values()].map((r) => ({ ...r })).sort(compareRows);
  }

  toJSON(): ReportRow[] {
    return this.toRows();
  }

  /** Rebuilds a report from `toRows()` output; throws on anything else. */
  static fromRows(value: unknown): ImportReport {
    if (!Array.isArray(value)) throw new Error("report is not an array");
    const report = new ImportReport();
    for (const row of value) {
      if (!row || typeof row !== "object") throw new Error("report row is not an object");
      const r = row as Record<string, unknown>;
      if (typeof r.day !== "string" || typeof r.reason !== "string") throw new Error("report row without day or reason");
      const counts: Partial<ReportCounts> = {};
      for (const k of COUNT_KEYS) {
        const n = r[k];
        if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new Error(`report row with an invalid ${k}`);
        counts[k] = n;
      }
      report.add(r.day, r.reason, counts);
    }
    return report;
  }
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The CSV of `--report`: header, one line per row, then the total line. */
export function reportCsv(report: ImportReport): string {
  const lines = [CSV_HEADER];
  for (const r of report.toRows()) {
    lines.push([csvField(r.day), csvField(r.reason), r.read, r.inserted, r.duplicates, r.refused].join(","));
  }
  const t = report.totals();
  lines.push(`total,,${t.read},${t.inserted},${t.duplicates},${t.refused}`);
  return `${lines.join("\n")}\n`;
}

/** The same rows as the CSV, as an aligned table for the terminal. */
export function renderReport(report: ImportReport): string {
  const t = report.totals();
  const table: string[][] = [
    ["day", "reason", "read", "inserted", "duplicates", "refused"],
    ...report.toRows().map((r) => [r.day, r.reason || "-", String(r.read), String(r.inserted), String(r.duplicates), String(r.refused)]),
    ["total", "", String(t.read), String(t.inserted), String(t.duplicates), String(t.refused)],
  ];
  const widths = table[0]!.map((_, col) => Math.max(...table.map((row) => row[col]!.length)));
  const lines = table.map((row) =>
    row
      .map((cell, col) => (col < 2 ? cell.padEnd(widths[col]!) : cell.padStart(widths[col]!)))
      .join("  ")
      .trimEnd(),
  );
  return `${lines.join("\n")}\n`;
}
