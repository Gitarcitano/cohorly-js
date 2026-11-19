import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

/** Files under `root`, sorted, following symlinks; a directory reached twice (a link cycle) is visited once. */
export async function walk(root: string, options: { includeDirs?: boolean } = {}): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = async (dir: string) => {
    const real = await realpath(dir);
    if (seen.has(real)) return;
    seen.add(real);
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        const target = await stat(full).catch(() => null);
        isDir = target?.isDirectory() ?? false;
        isFile = target?.isFile() ?? false;
      }
      if (isDir) {
        if (entry.name === "node_modules") continue;
        if (options.includeDirs) out.push(full);
        await visit(full);
      } else if (isFile) {
        out.push(full);
      }
    }
  };
  await visit(root);
  return out;
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export function bundleKey(root: string, bundlePath: string): string {
  return `~/${path.relative(root, bundlePath).split(path.sep).join("/")}`;
}
