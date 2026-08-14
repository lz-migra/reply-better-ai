import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const storageMock = {
  data: {},
  get(keys) {
    const ks = Array.isArray(keys) ? keys : [keys];
    return Promise.resolve(Object.fromEntries(ks.filter(k => k in this.data).map(k => [k, this.data[k]])));
  },
  set(obj) { Object.assign(this.data, obj); return Promise.resolve(); },
  remove(keys) {
    const ks = Array.isArray(keys) ? keys : [keys];
    ks.forEach(k => delete this.data[k]);
    return Promise.resolve();
  },
};

vi.mock("../src/lib/browser.js", () => ({
  default: { storage: { local: {} } },
}));
vi.mock("../src/lib/storage.js", () => ({
  storage: undefined, // replaced per-test
  NetworkError: class NetworkError extends Error {
    constructor(m) { super(m); this.name = "NetworkError"; }
  },
}));

// Force-import the module so we can replace `storage` after the fact. Since
// `getGroqModels` reads `storage` lazily at call time, we just need to set
// `globalThis` before each test.
let getGroqModels;
let NetworkError;

beforeEach(async () => {
  storageMock.data = {};
  const mod = await import("../src/lib/groq-models.js");
  getGroqModels = mod.getGroqModels;
  NetworkError = (await import("../src/lib/errors.js")).NetworkError;
  // Reach into the module's closure: storage is imported by name. Easiest path
  // is to monkey-patch the imported module's `storage` export.
  const storageMod = await import("../src/lib/storage.js");
  storageMod.storage = storageMock;
});

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = undefined;
});

describe("getGroqModels", () => {
  it("returns needs-key when no Groq key is stored", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    const result = await getGroqModels();
    expect(result.source).toBe("needs-key");
    expect(result.models).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches the live list from /openai/v1/models and caches it", async () => {
    storageMock.data.groqApiKey = "gsk_test";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        object: "list",
        data: [
          { id: "llama-3.3-70b-versatile", object: "model", owned_by: "Meta", context_window: 131072, active: true },
          { id: "whisper-large-v3", object: "model", owned_by: "OpenAI", context_window: 448, active: true },
          { id: "deprecated-model", object: "model", owned_by: "Meta", context_window: 4096, active: false },
        ],
      }),
    }));
    globalThis.fetch = fetchMock;
    const result = await getGroqModels();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.groq.com/openai/v1/models",
      expect.objectContaining({ headers: { Authorization: "Bearer gsk_test" } }),
    );
    expect(result.source).toBe("fresh");
    expect(result.models.map(m => m.id)).toEqual([
      "llama-3.3-70b-versatile",
      "whisper-large-v3",
    ]);
    expect(storageMock.data.groqModelsCache.models.length).toBe(2);
  });

  it("returns the cached list when fresh and within TTL", async () => {
    storageMock.data.groqApiKey = "gsk_test";
    storageMock.data.groqModelsCache = {
      models: [{ id: "llama-3.1-8b-instant", owned_by: "Meta", context_window: 131072 }],
      cachedAt: Date.now() - 60_000,
    };
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const result = await getGroqModels();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.source).toBe("cache");
    expect(result.models[0].id).toBe("llama-3.1-8b-instant");
  });

  it("refetches when the cache is past TTL", async () => {
    storageMock.data.groqApiKey = "gsk_test";
    storageMock.data.groqModelsCache = {
      models: [{ id: "old-model", owned_by: "OldCo", context_window: 4096 }],
      cachedAt: Date.now() - (60 * 60 * 1000 + 1000),
    };
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ object: "list", data: [{ id: "new-model", owned_by: "NewCo", context_window: 8192, active: true }] }),
    }));
    const result = await getGroqModels();
    expect(result.source).toBe("fresh");
    expect(result.models[0].id).toBe("new-model");
  });

  it("throws NetworkError on a non-2xx response", async () => {
    storageMock.data.groqApiKey = "gsk_test";
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    await expect(getGroqModels()).rejects.toThrow(NetworkError);
  });

  it("throws NetworkError when fetch itself fails", async () => {
    storageMock.data.groqApiKey = "gsk_test";
    globalThis.fetch = vi.fn(async () => { throw new TypeError("network down"); });
    await expect(getGroqModels()).rejects.toThrow(NetworkError);
  });

  it("force-refresh bypasses the cache and overwrites it", async () => {
    storageMock.data.groqApiKey = "gsk_test";
    storageMock.data.groqModelsCache = {
      models: [{ id: "cached-old", owned_by: "Cached", context_window: 1 }],
      cachedAt: Date.now(),
    };
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ object: "list", data: [{ id: "fresh-new", owned_by: "Fresh", context_window: 2, active: true }] }),
    }));
    const result = await getGroqModels({ forceRefresh: true });
    expect(result.source).toBe("fresh");
    expect(storageMock.data.groqModelsCache.models[0].id).toBe("fresh-new");
  });
});
