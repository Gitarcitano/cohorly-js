# @cohorly/cli

Command line and build plugins for [Cohorly](https://github.com/Gitarcitano/cohorly-js) error tracking. It runs on your build machine and uploads what Cohorly needs to symbolicate errors: a compact index of each source map (web, React Native, Hermes), R8 `mapping.txt` files and, on macOS, a symcache of each dSYM slice. `sourcesContent` and the dSYM itself never leave the build machine.

**Documentation:** [Cohorly CLI](https://cohorly-docs.velloalabs.com/cli)

Requires Node 22+.

## Installation

```sh
npm install --save-dev @cohorly/cli
```

## Usage

```sh
export COHORLY_UPLOAD_TOKEN=...   # project upload token, never printed

cohorly sourcemaps inject dist
cohorly sourcemaps upload --release web@2026.11.3 --dist b71e04 dist
cohorly debug-files upload --release android@3.8.1+415 app/build/outputs/mapping/release
```

`debug-files upload` also takes `.dSYM`s (macOS with the Xcode command line tools only): one symcache per arch slice, keyed by its `LC_UUID`.

`--release` and `--dist` must equal the `$exception_release` and `$exception_dist` your SDK sends. `COHORLY_API_URL` (or `--api-url`) points the CLI at a self-hosted server. Every command has `--help`.

The CLI exits non-zero when any upload fails (after trying the rest), so a CI build fails instead of shipping a release nobody can symbolicate. The index format and the upload protocol are specified in [docs/SOURCEMAP-INDEX.md](https://github.com/Gitarcitano/cohorly/blob/main/docs/SOURCEMAP-INDEX.md).

## Import from Mixpanel

```sh
export COHORLY_IMPORT_TOKEN=...   # organization API key allowed to import, never printed

cohorly import mixpanel --project 12 --hash-prop email --drop-prop ip --report import-report.csv exports/
```

Reads a raw Mixpanel event export (one JSON event per line; `.json`, `.jsonl`, `.ndjson`, optionally `.gz`) and sends it to the project's historical import endpoint. Progress is saved next to each file (`<file>.cohorly-import.json`), so running the same command again resumes; importing a file twice stores it once. Guide: [Migrate from Mixpanel](https://cohorly-docs.velloalabs.com/migrate-from-mixpanel).

```bash
cohorly import mixpanel-lexicon --project 12 --dry-run schemas.json
```

Writes the names, descriptions, tags and hidden flags of a Mixpanel Lexicon schemas export to the project's Lexicon. Fields already filled are kept (`--overwrite` replaces them); `dropped`, `mergedInto` and `verified` are never written. Needs an `import` scope key.
### Profiles

```sh
cohorly import mixpanel-profiles --project 12 --hash-prop '$email' --report profiles-report.csv profiles/
```

Reads Mixpanel user profiles (a profile export page `{ "results": [...] }`, a JSON array, or one profile per line; optionally `.gz`) and sends them to the project's profile import endpoint. Each profile only fills in what Cohorly lacks (`$set_once`), with no IP geolocation and no import-time `$last_seen`. `$distinct_id` cannot be dropped or hashed. Same credential, options and resume behavior as the event import; the CSV report is `reason,read,applied,refused`.

## Build plugins

- **Expo / React Native**: `"plugins": ["@cohorly/cli"]` in `app.json`. Release builds upload the bundle's source map (and dSYMs on iOS, the R8 mapping on Android) from an Xcode build phase and a Gradle task; a failed upload fails the build, `COHORLY_UPLOAD_DISABLED=1` skips it. For EAS Update, run `cohorly expo upload-update --update-json update.json dist` after `eas update --json`.
- **Vite**: `import { cohorlyVitePlugin } from "@cohorly/cli/vite"`, then `cohorlyVitePlugin({ release })`.
- **Next.js 15.4+**: `import { withCohorly } from "@cohorly/cli/next"`, then `export default withCohorly(nextConfig, { release })`.

The Vite and Next plugins take `release`, `dist`, `token`, `apiUrl`, `disabled` and `deleteSourceMapsAfterUpload`.

## License

Apache-2.0
