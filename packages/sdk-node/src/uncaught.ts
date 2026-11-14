/**
 * Process-wide `uncaughtException` / `unhandledRejection` handling for
 * `captureUncaught: true`. One pair of listeners serves every client, so two
 * clients never see each other as "another listener" and never both decide
 * the process's fate.
 *
 * Listening to either event switches off Node's default behaviour for it,
 * so after capturing and flushing (with a timeout) the handlers reproduce
 * what Node would have done without them: an uncaught exception is rethrown
 * with no listener left (Node prints it and exits 1), an unhandled rejection
 * follows the `--unhandled-rejections` mode.
 */

export type UncaughtKind = "uncaughtException" | "unhandledRejection";

export interface UncaughtClient {
  /** Queues `error` as an exception of `kind`. Never throws. */
  captureUncaughtError(error: unknown, kind: UncaughtKind): void;
  /** Never rejects, resolves within the client's flushTimeoutMs. */
  flushWithTimeout(): Promise<boolean>;
}

const clients = new Set<UncaughtClient>();
let installed = false;

const seenObjects = new WeakSet<object>();

/**
 * Under `--unhandled-rejections=strict` Node emits one rejection twice, back
 * to back in the same synchronous call: first `uncaughtException` with
 * origin `"unhandledRejection"` (for a non-Error reason, an
 * `ERR_UNHANDLED_REJECTION` error that only quotes the reason in its
 * message), then `unhandledRejection` with the original reason. The first
 * emission parks its error here; the second one claims it, so the pair is
 * one event built from the original reason.
 */
let pendingStrict: { error: unknown; sole: boolean } | undefined;

/**
 * True the first time `value` is seen. Objects are remembered for good (the
 * same Error rethrown later is not a new error). A primitive is always new:
 * two `Promise.reject("boom")` are two errors.
 */
function firstSighting(value: unknown): boolean {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    if (seenObjects.has(value as object)) return false;
    seenObjects.add(value as object);
  }
  return true;
}

function flushAll(): Promise<unknown> {
  return Promise.all([...clients].map((client) => client.flushWithTimeout()));
}

function captureAll(error: unknown, kind: UncaughtKind): void {
  for (const client of clients) client.captureUncaughtError(error, kind);
}

/** What Node raises for a rejection nobody handled: the reason if it is an Error, else this wrapper. */
function rejectionError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const wrapper = new Error(
    "This error originated either by throwing inside of an async function without a catch block, " +
      `or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "${describe(reason)}".`,
  );
  wrapper.name = "UnhandledPromiseRejection";
  (wrapper as Error & { code: string }).code = "ERR_UNHANDLED_REJECTION";
  return wrapper;
}

/**
 * Default (`throw`) mode, after the flush: raises the rejection as Node does
 * without an `unhandledRejection` listener. The app's own `uncaughtException`
 * listeners get it with origin `"unhandledRejection"` (and Node's wrapper
 * error for a non-Error reason); with none, it crashes the process. Our
 * listeners step aside for it, since it was captured already.
 */
function raiseRejection(reason: unknown): void {
  const error = rejectionError(reason);
  uninstall();
  let handled = false;
  try {
    // The typings of Process.emit have no overload for this event.
    handled = (process as NodeJS.EventEmitter).emit("uncaughtException", error, "unhandledRejection");
  } catch (thrown) {
    process.nextTick(() => {
      throw thrown;
    });
    return;
  }
  if (!handled) {
    process.nextTick(() => {
      throw error;
    });
    return;
  }
  if (clients.size > 0) install();
}

/** Without a listener left, Node prints `error` and exits 1, exactly as it would have. */
function crashWith(error: unknown): void {
  uninstall();
  process.nextTick(() => {
    throw error;
  });
}

function onUncaughtException(error: unknown, origin?: string): void {
  // Ours is the only listener: without the SDK, Node would crash right now.
  const sole = process.listenerCount("uncaughtException") <= 1;
  if (origin === "unhandledRejection") {
    // Strict mode; the unhandledRejection that follows carries the reason.
    const parked = { error, sole };
    pendingStrict = parked;
    // Fallback if that second emission never comes: report the wrapper.
    process.nextTick(() => {
      if (pendingStrict === parked) settleStrict(error);
    });
    return;
  }
  const first = firstSighting(error);
  if (!first) {
    // Already captured: it was flushed when it was first seen, so a second
    // flush would only add a second deadline.
    if (sole) crashWith(error);
    return;
  }
  captureAll(error, "uncaughtException");
  if (!sole) {
    void flushAll();
    return;
  }
  // If the loop empties while we flush, the process must still exit 1.
  process.exitCode = 1;
  void flushAll().then(() => crashWith(error));
}

/**
 * Ends a strict-mode rejection: one event from `reason` (the original value
 * when the unhandledRejection emission delivered it), then the crash Node
 * would have done, rethrowing the error Node itself raised.
 */
function settleStrict(reason: unknown): void {
  const parked = pendingStrict;
  pendingStrict = undefined;
  if (!parked) return;
  if (firstSighting(reason)) captureAll(reason, "unhandledRejection");
  if (!parked.sole) {
    void flushAll();
    return;
  }
  process.exitCode = 1;
  void flushAll().then(() => crashWith(parked.error));
}

function onUnhandledRejection(reason: unknown): void {
  if (pendingStrict) {
    settleStrict(reason);
    return;
  }
  const othersListening = process.listenerCount("unhandledRejection") > 1;
  if (!firstSighting(reason)) return;
  captureAll(reason, "unhandledRejection");
  if (othersListening) {
    // Another hook handles it, so Node would not have crashed or warned either.
    void flushAll();
    return;
  }
  const mode = unhandledRejectionsMode();
  if (mode === "throw") {
    if (process.listenerCount("uncaughtException") <= 1) process.exitCode = 1;
    void flushAll().then(() => raiseRejection(reason));
    return;
  }
  if (mode === "warn-with-error-code") {
    process.exitCode = 1;
    process.emitWarning(
      `Unhandled promise rejection: ${describe(reason)}`,
      "UnhandledPromiseRejectionWarning",
    );
  }
  // warn: Node warns whether or not a hook exists. none: silent. strict:
  // already settled through the uncaughtException emission above.
  void flushAll();
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? String(value);
  try {
    return String(value);
  } catch {
    return typeof value;
  }
}

/**
 * The effective `--unhandled-rejections` mode: NODE_OPTIONS first, the
 * command line after it (the command line wins), default `throw`.
 */
export function unhandledRejectionsMode(): string {
  const flags = [
    ...(process.env.NODE_OPTIONS?.split(/\s+/).filter(Boolean) ?? []),
    ...process.execArgv,
  ];
  let mode = "throw";
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag.startsWith("--unhandled-rejections=")) {
      mode = flag.slice("--unhandled-rejections=".length);
    } else if (flag === "--unhandled-rejections" && i + 1 < flags.length) {
      mode = flags[++i];
    }
  }
  return mode;
}

function install(): void {
  if (installed) return;
  installed = true;
  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);
}

function uninstall(): void {
  if (!installed) return;
  installed = false;
  pendingStrict = undefined;
  process.removeListener("uncaughtException", onUncaughtException);
  process.removeListener("unhandledRejection", onUnhandledRejection);
}

/** Starts sending this client the process's uncaught errors. Idempotent. */
export function registerUncaught(client: UncaughtClient): void {
  clients.add(client);
  install();
}

/** Stops it; the listeners go away with the last client. */
export function unregisterUncaught(client: UncaughtClient): void {
  clients.delete(client);
  if (clients.size === 0) uninstall();
}
