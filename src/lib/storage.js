// Storage is split into two parts:
//
//   * `createStorage(backend)` — builds a `storage` adapter from a backend that
//     implements `get(keys)` / `set(obj)` / `remove(keys)`. The extension uses
//     a chrome.storage.local backend; the userscript uses GM_*Value.
//
//   * `setSelectedModel`, `migrateStyleKey`, `migrateFromSync` — helpers that
//     take a backend directly so both runtimes can use them.
//
// Migration helpers (`migrateStyleKey`, `migrateFromSync`) are extension-only
// concerns (they exist to reconcile historical chrome.storage.sync layouts)
// and become no-ops when invoked with the userscript backend.

import browserPolyfill from "./browser.js";

export function createStorage(backend) {
  if (!backend || typeof backend.get !== "function") {
    throw new Error("createStorage: backend must implement get/set/remove");
  }
  return {
    get(keys) { return backend.get(keys); },
    set(obj) { return backend.set(obj); },
    remove(keys) { return backend.remove(keys); },
    onChanged(cb) {
      if (typeof backend.onChanged !== "function") return () => {};
      // Chrome.storage.onChanged needs the real API at subscription time; we
      // call the backend now and return its unsubscribe synchronously.
      return backend.onChanged(cb);
    },
  };
}

// Chrome.storage.local backend (default for the extension).
// Resolves the webextension-polyfill API once via the static import and closes
// over it; each method is still async to match the backend contract.
export const chromeBackend = {
  async get(keys) { return browserPolyfill.storage.local.get(keys); },
  async set(obj) { return browserPolyfill.storage.local.set(obj); },
  async remove(keys) { return browserPolyfill.storage.local.remove(keys); },
  // chrome.storage.onChanged needs the API at subscription time, so we resolve
  // it synchronously from the captured polyfill reference and return an
  // unsubscribe function (createStorage's wrapper hands it back to callers).
  onChanged(cb) {
    const handler = (changes, area) => { if (area === "local") cb(changes, area); };
    browserPolyfill.storage.onChanged.addListener(handler);
    return () => browserPolyfill.storage.onChanged.removeListener(handler);
  },
};

// Default `storage` instance used by the extension runtime: chrome.storage.local
// wrapped by createStorage(). The userscript runtime builds its own from gmBackend().
export const storage = createStorage(chromeBackend);

// Tampermonkey GM_*Value backend (userscript).
// `keys` may be a string, an array, or null (meaning "all keys"). GM_getValue
// doesn't natively support multi-key reads, so we serialize per-key calls.
export function gmBackend() {
  return {
    async get(keys) {
      if (keys === null || keys === undefined) {
        // GM_listValues isn't in our @grant list; userscripts typically don't
        // need this code path. Throw so the user adds it if they really want it.
        throw new Error("gmBackend: full-key listing is not supported");
      }
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) {
        const v = GM_getValue(k);
        if (v !== undefined) out[k] = v;
      }
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) GM_setValue(k, v);
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? [keys] : keys;
      for (const k of list) GM_deleteValue(k);
    },
  };
}

export async function setSelectedModel(backend, id) {
  await backend.set({ model: id });
  await backend.remove(["modelFallbackNotice"]);
}

// Default writing style used to be split across two keys (`messageType` in
// popup, `inlineMessageType` in options) so the option didn't reach the popup.
// Collapse to `messageType`; explicit "Default style" wins. Idempotent.
export async function migrateStyleKey() {
  try {
    const { inlineMessageType } = await browserPolyfill.storage.local.get(["inlineMessageType"]);
    if (inlineMessageType !== undefined) {
      await browserPolyfill.storage.local.set({ messageType: inlineMessageType });
      await browserPolyfill.storage.local.remove(["inlineMessageType"]);
    }
  } catch (e) {
    console.warn("[storage] style-key migration failed:", e?.message);
  }
}

// Wrapper kept for callers that still pass a backend argument; ignored.
export async function migrateFromSync(_backend) {
  await migrateStyleKey();
}
