/**
 * Package version, stamped on every event as `$lib_version`. Kept as a plain
 * constant (rather than importing package.json) so the package stays standalone
 * and bundler-friendly. Synced with package.json "version" at release time
 * by scripts/sync-versions.mjs.
 */
export const VERSION = "0.5.0";
