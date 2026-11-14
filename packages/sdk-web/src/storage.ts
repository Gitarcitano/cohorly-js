import type { CohorlyStorage } from "@cohorly/core";

// In-memory fallback used during SSR (no window) or if localStorage throws
// (privacy mode / quota exceeded).
const memory = new Map<string, string>();

function hasLocalStorage(): boolean {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch {
    return false;
  }
}

export const localStorageAdapter: CohorlyStorage = {
  get(key) {
    if (!hasLocalStorage()) return memory.get(key) ?? null;
    try {
      return window.localStorage.getItem(key);
    } catch {
      return memory.get(key) ?? null;
    }
  },
  set(key, value) {
    if (!hasLocalStorage()) {
      memory.set(key, value);
      return;
    }
    try {
      window.localStorage.setItem(key, value);
    } catch {
      memory.set(key, value);
    }
  },
  remove(key) {
    if (!hasLocalStorage()) {
      memory.delete(key);
      return;
    }
    try {
      window.localStorage.removeItem(key);
    } catch {
      memory.delete(key);
    }
  },
};

const sessionMemory = new Map<string, string>();

function hasSessionStorage(): boolean {
  try {
    return typeof window !== "undefined" && !!window.sessionStorage;
  } catch {
    return false;
  }
}

/** Per-tab storage (survives a reload, not shared with other tabs); memory fallback like localStorageAdapter. */
export const sessionStorageAdapter: CohorlyStorage = {
  get(key) {
    if (!hasSessionStorage()) return sessionMemory.get(key) ?? null;
    try {
      return window.sessionStorage.getItem(key);
    } catch {
      return sessionMemory.get(key) ?? null;
    }
  },
  set(key, value) {
    if (!hasSessionStorage()) {
      sessionMemory.set(key, value);
      return;
    }
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      sessionMemory.set(key, value);
    }
  },
  remove(key) {
    if (!hasSessionStorage()) {
      sessionMemory.delete(key);
      return;
    }
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      sessionMemory.delete(key);
    }
  },
};
