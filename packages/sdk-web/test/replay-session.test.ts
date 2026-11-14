import type { CohorlyStorage } from "@cohorly/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReplayMode, SessionStoreOptions } from "../src/replay/session.js";
import { ReplaySessionStore, SESSION_IDLE_MS, SESSION_MAX_MS } from "../src/replay/session.js";

/** One tab's sessionStorage. */
function tabStorage(): CohorlyStorage {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
  };
}

const T0 = Date.UTC(2026, 10, 14, 12, 0, 0);

describe("replay session (per tab)", () => {
  let clock = T0;
  const stores: ReplaySessionStore[] = [];

  function store(storage: CohorlyStorage, options: Partial<SessionStoreOptions> = {}) {
    const created = new ReplaySessionStore({
      storage,
      decideMode: (): ReplayMode => "session",
      now: () => clock,
      pageToken: `page-${stores.length}`,
      navigationType: "navigate",
      ...options,
    });
    stores.push(created);
    return created;
  }

  afterEach(() => {
    for (const s of stores.splice(0)) s.dispose();
    clock = T0;
  });

  it("two tabs (two sessionStorages) get two sessions", () => {
    const a = store(tabStorage());
    const b = store(tabStorage());
    expect(a.last().id).not.toBe(b.last().id);
  });

  it("a reload, or a navigation in the same tab, keeps the session id and its next seq", () => {
    const storage = tabStorage();
    const first = store(storage);
    expect([first.takeSeq(first.last().id), first.takeSeq(first.last().id)]).toEqual([0, 1]);
    window.dispatchEvent(new Event("pagehide")); // the page goes away
    first.dispose();

    const reloaded = store(storage, { navigationType: "reload" });
    expect(reloaded.last().id).toBe(first.last().id);
    expect(reloaded.takeSeq(reloaded.last().id)).toBe(2);
    window.dispatchEvent(new Event("pagehide"));
    reloaded.dispose();

    const navigated = store(storage, { navigationType: "navigate" });
    expect(navigated.last().id).toBe(first.last().id);
  });

  it("a duplicated tab (the original's marker copied, not a reload) mints a new session", () => {
    const storage = tabStorage();
    const original = store(storage);
    // Duplicating copies sessionStorage while the original page is still open.
    const copy = tabStorage();
    for (const key of ["chl_replay_session", "chl_replay_tab"]) copy.set(key, storage.get(key) as string);

    const duplicate = store(copy, { navigationType: "navigate" });
    expect(duplicate.last().id).not.toBe(original.last().id);
    expect(duplicate.takeSeq(duplicate.last().id)).toBe(0);
    // The same copy restored as back_forward is the same tab's history, not a duplicate.
    const restored = tabStorage();
    for (const key of ["chl_replay_session", "chl_replay_tab"]) restored.set(key, storage.get(key) as string);
    expect(store(restored, { navigationType: "back_forward" }).last().id).toBe(original.last().id);
  });

  it("expires after 30 min idle but rotates only on activity", () => {
    const onRotate = vi.fn();
    const s = store(tabStorage(), { onRotate });
    const first = s.last().id;
    clock += SESSION_IDLE_MS + 1;
    expect(s.active()).toBeNull();
    expect(s.last().id).toBe(first);
    expect(onRotate).not.toHaveBeenCalled();

    const next = s.touch();
    expect(next.id).not.toBe(first);
    expect(next.seq).toBe(0);
    expect(onRotate).toHaveBeenCalledWith(next);
  });

  it("ends after 24 hours even with constant activity", () => {
    const s = store(tabStorage());
    const first = s.last().id;
    while (clock - T0 < SESSION_MAX_MS) {
      expect(s.touch().id).toBe(first);
      clock += 20 * 60_000;
    }
    clock += 1; // just past 24 h, 20 min after the last activity
    expect(s.active()).toBeNull();
    expect(s.touch().id).not.toBe(first);
  });

  it("keeps handing out seqs of a session rotated out (its chunks may still be queued)", () => {
    const s = store(tabStorage());
    const old = s.last().id;
    expect(s.takeSeq(old)).toBe(0);
    s.rotate();
    expect(s.takeSeq(old)).toBe(1);
    expect(s.takeSeq(s.last().id)).toBe(0);
  });
});
