# @cohorly/cli

## 0.2.2

### Patch Changes

- a8ad42a: `debug-files upload` and `react-native xcode` no longer fail the build when the server answers `409 debug_id already uploaded` for a dSYM slice: an unchanged framework (Firebase, an app extension) rebuilt under another DerivedData keeps its LC_UUID while its symcache carries other absolute paths, so the copy on the server already serves it. The slice is printed as `already uploaded <file> (<arch> <uuid>)` and counted in the summary (`N already uploaded`). Any other status, a network error, and a `409` for a source map index still fail with exit 1.

## 0.2.1

### Patch Changes

- 21ec8c1: Expo plugin: the iOS "Upload symbols to Cohorly" phase is now placed after every build phase the target has when the plugin runs (phases `pod install` appends later may follow it), and `expo prebuild` moves it there in projects prebuilt with 0.1.1. It is also marked to run on every build, so Xcode no longer warns that it has no outputs. Since 0.1.1 it read the dSYM and Info.plist while sitting before phases that still write into the app bundle (Copy Pods Resources, Embed Watch Content), so `xcodebuild archive` failed with a dependency cycle.

## 0.2.0

### Minor Changes

- b65407d: New `cohorly import mixpanel-lexicon --project <id> <schemas.json>`: writes the names, descriptions, tags and hidden flags of a Mixpanel Lexicon schemas export to the project's Lexicon through `PUT /api/lexicon/:type/:name`. Fields already filled are kept (`--overwrite` replaces them), `dropped`, `mergedInto` and `verified` are never written, unsupported kinds are skipped and counted, `--dry-run` writes nothing, and the summary lists created, updated, already filled, unsupported and failed entries.
- cac6189: New `cohorly import mixpanel --project <id> <path>`: imports a raw Mixpanel event export (JSON lines, optionally gzipped, one file or a directory) into a project through `POST /api/import/events`. Streams with constant memory, converts `time` in seconds to milliseconds, copies `mp_lib` to `$lib`, can drop or hash properties (`--drop-prop`, `--hash-prop`), waits out `429`/`503` and retries server errors, splits batches answered `413`, resumes from `<file>.cohorly-import.json` (`--restart` to start over) and reports every event by UTC day and reason, in the terminal and as CSV (`--report`).

### Patch Changes

- f5a594d: `cohorly import mixpanel` keeps each batch within 3 UTC months of events: the server now creates at most 3 new monthly partitions per import request and refuses events of further new months as `too_many_months`, so the CLI starts a new batch before an event that would open a fourth month.
- fcea729: Symbol uploads wait out a `429` (another upload of the same org still being received, e.g. two parallel builds) instead of failing: each wait follows the server's `Retry-After` (at least 1 s, at most 60 s), up to 5 minutes in total, without spending one of the three attempts. `5xx` retries also honor `Retry-After` when the server sends one.

## 0.1.1

### Patch Changes

- 2bf73b0: Expo plugin: the iOS "Upload symbols to Cohorly" phase declares the app's dSYM and Info.plist as input files, so `xcodebuild archive` runs it after they are written. `debug-files upload` skips 32-bit slices (watchOS `arm64_32`) with a warning instead of failing, and `./app.plugin.cjs` is exported.
