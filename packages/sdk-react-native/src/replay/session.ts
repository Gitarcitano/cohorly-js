/**
 * The replay session (`$session_id`) of the app, persisted in the injected
 * storage under a key per project token: id, start, last activity, when the
 * app went to background, the sampling draw, the next chunk seq, and the
 * replay quota pause. A relaunch inside the same session continues it with
 * the same draw (it is never drawn again).
 *
 * Rotation (docs/SESSION-REPLAY.md "Session end", with the web SDK's
 * comparisons, strictly more than the limit):
 * - on the first foreground more than 30 min after the app went to
 *   background, or more than 24 h after the session started;
 * - on the first activity (a tracked event that is not SDK-internal) in the
 *   foreground more than 30 min after the last activity, or more than 24 h
 *   after the session started;
 * - at launch, by the same rules, against the stored record;
 * - on `reset()`, at once.
 *
 * Storage is async: until `load()` read it, the store serves a provisional
 * session minted in the constructor, adopted as the session when nothing
 * live was stored. Its sampling draw is made only then: adopting a stored
 * session never draws. Nothing is written before `load()`, so the
 * provisional session never overwrites a stored one it has not read yet; a
 * background transition seen meanwhile is kept by the adopted session.
 * Writes reach storage one at a time, in order; `persisted()` waits for
 * them (a chunk's seq is persisted before the chunk is sent).
 *
 * With the project's settings (`remoteConfig`, VEL-2238) a new session may
 * be born `pending`: it has its id at once and `settle()` decides it later,
 * once. A decided session is never drawn again and keeps the minimum
 * duration it was decided with. A record written before VEL-2238 (no
 * `minDurationMs`) reads as decided with no minimum duration.
 */
import type { AsyncStorageLike } from "../types.js";
import { uuid } from "../uuid.js";
import type { ReplayDraw } from "./options.js";

export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_MAX_MS = 24 * 60 * 60 * 1000;
/** Activity is persisted at most this often (the in-memory value is exact). */
const ACTIVITY_WRITE_MS = 5000;

export function replayStorageKey(token: string | undefined): string {
  return `cohorly:replay_session:${token ?? ""}`;
}

export interface ReplaySessionState {
  id: string;
  startedAt: number;
  lastActivity: number;
  /** When the app last went to background; null while in the foreground. */
  backgroundAt: number | null;
  draw: ReplayDraw;
  /** The next chunk seq. */
  seq: number;
  /** Session mode holds what it records until it is this long (VEL-2238); decided with the draw, absent = 0. */
  minDurationMs?: number;
}

interface StoredRecord extends ReplaySessionState {
  /** Session-mode recording is paused by the replay quota until this time (ms). */
  quotaPausedUntil?: number;
}

const DRAWS: readonly string[] = ["session", "error", "none", "pending"];

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseRecord(raw: string | null): StoredRecord | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredRecord> | null;
    if (
      typeof v !== "object" ||
      v === null ||
      typeof v.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(v.id) ||
      !finite(v.startedAt) ||
      !finite(v.lastActivity) ||
      !(v.backgroundAt === null || v.backgroundAt === undefined || finite(v.backgroundAt)) ||
      typeof v.draw !== "string" ||
      !DRAWS.includes(v.draw) ||
      !Number.isInteger(v.seq) ||
      (v.seq as number) < 0 ||
      !(v.minDurationMs === undefined || (finite(v.minDurationMs) && v.minDurationMs >= 0))
    ) {
      return null;
    }
    return {
      id: v.id,
      startedAt: v.startedAt,
      lastActivity: v.lastActivity,
      backgroundAt: v.backgroundAt ?? null,
      draw: v.draw as ReplayDraw,
      seq: v.seq as number,
      ...(finite(v.minDurationMs) && v.minDurationMs > 0 ? { minDurationMs: v.minDurationMs } : {}),
      ...(finite(v.quotaPausedUntil) ? { quotaPausedUntil: v.quotaPausedUntil } : {}),
    };
  } catch {
    return null;
  }
}

export interface SessionStoreOptions {
  storage: AsyncStorageLike;
  key: string;
  /** The sampling draw of a new session, made once per session id (`pending` leaves it to `settle()`). */
  draw: () => ReplayDraw;
  /** The minimum duration of a NEW session decided now (read right after `draw`, never for `pending`). Default 0. */
  minDurationMs?: () => number;
  now: () => number;
  /** After a rotation (not at launch), with the new session and the one it replaced. */
  onRotate?: (session: ReplaySessionState, previous: ReplaySessionState) => void;
}

export class ReplaySessionStore {
  private current: ReplaySessionState;
  private quotaUntil = 0;
  private loaded = false;
  /** reset() ran before load(): the stored session is the outgoing one. */
  private rotatedBeforeLoad = false;
  private lastWrite = Number.NEGATIVE_INFINITY;
  private writes: Promise<void> = Promise.resolve();
  /** The provisional session's draw is not made yet (it is, in load(), unless a stored session is adopted). */
  private undrawn = true;
  /** Next seq of sessions rotated out in this process whose chunks may still be built. */
  private readonly retired = new Map<string, number>();

  constructor(private readonly options: SessionStoreOptions) {
    // Placeholder draw: nothing reads it before load() replaces it.
    this.current = this.mint(options.now(), "none");
  }

  /**
   * Reads the stored record: a live stored session becomes the session (its
   * id, draw and seq), else the provisional one stays. Returns the
   * provisional id and the adopted one when they differ, so events stamped
   * before the read can be stamped again.
   */
  async load(before?: Promise<unknown>): Promise<{ from: string; to: string } | null> {
    const read = (async (): Promise<StoredRecord | null> => {
      try {
        return parseRecord(await this.options.storage.getItem(this.options.key));
      } catch {
        return null;
      }
    })();
    // `before` (the remote settings copy) is read alongside: the draw below may need it.
    const [stored] = await Promise.all([read, before?.catch(() => {})]);
    this.loaded = true;
    const now = this.options.now();
    if (stored?.quotaPausedUntil !== undefined) {
      this.quotaUntil = Math.max(this.quotaUntil, stored.quotaPausedUntil);
    }
    let adopted: { from: string; to: string } | null = null;
    if (stored && !this.rotatedBeforeLoad && !this.expiredAtLaunch(stored, now)) {
      const provisional = this.current;
      const { quotaPausedUntil: _quota, ...session } = stored;
      // The launch is activity in the foreground. Gone to background while
      // the record was read: that transition stands, and no activity since.
      const away = provisional.backgroundAt;
      this.current = {
        ...session,
        lastActivity:
          away === null
            ? Math.max(now, provisional.lastActivity, session.lastActivity)
            : Math.max(provisional.lastActivity, session.lastActivity),
        backgroundAt: away,
      };
      adopted = { from: provisional.id, to: this.current.id };
    } else if (this.undrawn) {
      this.decide(this.current);
    }
    this.undrawn = false;
    this.write();
    return adopted;
  }

  /** Resolves once every write issued so far reached storage (or failed). */
  persisted(): Promise<void> {
    return this.writes;
  }

  /** The current session (stamped on every event). */
  last(): ReplaySessionState {
    return this.current;
  }

  /** A tracked event: in the foreground, rotates an expired session, else moves its last activity. */
  activity(foreground: boolean): ReplaySessionState {
    if (!foreground) return this.current;
    const now = this.options.now();
    if (now - this.current.lastActivity > SESSION_IDLE_MS || now - this.current.startedAt > SESSION_MAX_MS) {
      return this.rotate();
    }
    this.noteActivity(now);
    return this.current;
  }

  /** Recorded activity (drained screen changes): moves the last activity, never rotates. */
  noteActivity(now = this.options.now()): void {
    this.current.lastActivity = Math.max(this.current.lastActivity, now);
    if (now - this.lastWrite >= ACTIVITY_WRITE_MS) this.write();
  }

  background(): void {
    if (this.current.backgroundAt !== null) return;
    this.current.backgroundAt = this.options.now();
    this.write();
  }

  /** Back in the foreground: rotates after more than 30 min in background or 24 h of session. */
  foreground(): ReplaySessionState {
    const now = this.options.now();
    const away = this.current.backgroundAt;
    if ((away !== null && now - away > SESSION_IDLE_MS) || now - this.current.startedAt > SESSION_MAX_MS) {
      return this.rotate();
    }
    this.current.backgroundAt = null;
    this.current.lastActivity = Math.max(this.current.lastActivity, now);
    this.write();
    return this.current;
  }

  /** A new session: new id, new draw, seq 0. */
  rotate(): ReplaySessionState {
    const previous = this.current;
    this.retired.set(previous.id, previous.seq);
    this.current = this.mint(this.options.now(), "none");
    this.decide(this.current);
    this.undrawn = false;
    if (!this.loaded) this.rotatedBeforeLoad = true;
    this.write();
    this.options.onRotate?.(this.current, previous);
    return this.current;
  }

  /**
   * Takes the next chunk seq of a session: the live one (its increment is
   * written now; `persisted()` waits for it) or one rotated out in this
   * process.
   */
  takeSeq(sessionId: string): number {
    if (sessionId === this.current.id) {
      const seq = this.current.seq;
      this.current.seq = seq + 1;
      this.write();
      return seq;
    }
    const seq = this.retired.get(sessionId) ?? 0;
    this.retired.set(sessionId, seq + 1);
    return seq;
  }

  /**
   * Decides the live session when it is still `pending` and still `sessionId`
   * (a pending decision settling), persisted. False when there was nothing to
   * decide: a decided session never changes.
   */
  settle(sessionId: string, draw: Exclude<ReplayDraw, "pending">, minDurationMs = 0): boolean {
    if (sessionId !== this.current.id || this.current.draw !== "pending") return false;
    this.current.draw = draw;
    if (minDurationMs > 0) this.current.minDurationMs = minDurationMs;
    else delete this.current.minDurationMs;
    this.write();
    return true;
  }

  quotaPausedUntil(): number {
    return this.quotaUntil;
  }

  /** Session-mode recording is paused until `until` (ms), persisted across launches and rotations. */
  pauseQuota(until: number): void {
    this.quotaUntil = Math.max(this.quotaUntil, until);
    this.write();
  }

  private expiredAtLaunch(session: StoredRecord, now: number): boolean {
    // Killed in the background: idle since it went there; in the foreground: since its last activity.
    const idleSince = session.backgroundAt ?? session.lastActivity;
    return now - idleSince > SESSION_IDLE_MS || now - session.startedAt > SESSION_MAX_MS;
  }

  /** The draw (and minimum duration) of a new session, made once. */
  private decide(session: ReplaySessionState): void {
    session.draw = this.options.draw();
    const minDurationMs = session.draw === "pending" ? 0 : (this.options.minDurationMs?.() ?? 0);
    if (minDurationMs > 0) session.minDurationMs = minDurationMs;
    else delete session.minDurationMs;
  }

  private mint(now: number, draw: ReplayDraw): ReplaySessionState {
    return { id: uuid(), startedAt: now, lastActivity: now, backgroundAt: null, draw, seq: 0 };
  }

  private write(): void {
    // Before load() the stored record is unread: writing would replace it unseen.
    if (!this.loaded) return;
    this.lastWrite = this.options.now();
    const record: StoredRecord = {
      ...this.current,
      ...(this.quotaUntil > 0 ? { quotaPausedUntil: this.quotaUntil } : {}),
    };
    const json = JSON.stringify(record);
    // In order: an older record must never land after a newer one.
    this.writes = this.writes
      .then(() => this.options.storage.setItem(this.options.key, json))
      .catch(() => {
        // storage full or broken: the in-memory session still works
      });
  }
}
