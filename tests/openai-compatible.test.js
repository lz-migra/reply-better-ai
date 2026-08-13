import { describe, it, expect, vi, beforeEach } from "vitest";

let storeData = {};
vi.mock("../src/lib/browser.js", () => ({
  default: {
    storage: {
      local: {
        get: vi.fn(async keys => {
          const ks = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(ks.filter(k => k in storeData).map(k => [k, storeData[k]]));
        }),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      },
      sync: { get: vi.fn().mockResolvedValue({}), remove: vi.fn().mockResolvedValue(undefined) },
    },
  },
}));

// The SDK is heavy (and pulls a few node-only paths). We stub the factory with a
// minimal shape so tests stay focused on how we use it, not on SDK internals.
const createSpy = vi.fn();
vi.mock("openai", () => ({
  default: class OpenAI {
    constructor(opts) { this.opts = opts; }
    chat = { completions: { create: (...args) => createSpy(...args) } };
  },
}));

const { makeOpenAICompatibleEngine, fetchOpenAICompatibleModels } = await import("../src/engines/openai-compatible.js");
const errors = await import("../src/lib/errors.js");

const engine = makeOpenAICompatibleEngine();

function asyncIterFromArray(arr) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () => i < arr.length ? { value: arr[i++], done: false } : { value: undefined, done: true },
      };
    },
  };
}

beforeEach(() => {
  storeData = {};
  createSpy.mockReset();
  global.fetch = vi.fn();
});

describe("makeOpenAICompatibleEngine.availability", () => {
  it("returns needs-setup when neither base URL nor model is set", async () => {
    expect(await engine.availability()).toBe("needs-setup");
  });

  it("returns needs-setup when only base URL is set", async () => {
    storeData = { openaiCompatBaseUrl: "https://api.example.com/v1" };
    expect(await engine.availability()).toBe("needs-setup");
  });

  it("returns needs-setup when only model is set", async () => {
    storeData = { openaiCompatModel: "gpt-4o-mini" };
    expect(await engine.availability()).toBe("needs-setup");
  });

  it("returns ready when both base URL and model are set, even with no API key", async () => {
    storeData = { openaiCompatBaseUrl: "http://localhost:1234/v1", openaiCompatModel: "llama3" };
    expect(await engine.availability()).toBe("ready");
  });
});

describe("makeOpenAICompatibleEngine.streamImprove", () => {
  it("short-circuits with a clear error when base URL is missing", async () => {
    storeData = { openaiCompatModel: "gpt-4o-mini" };
    await expect(engine.streamImprove({ text: "x", systemPrompt: "s" })).rejects.toThrow(/base URL/i);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("short-circuits with a clear error when model is missing", async () => {
    storeData = { openaiCompatBaseUrl: "https://api.example.com/v1" };
    await expect(engine.streamImprove({ text: "x", systemPrompt: "s" })).rejects.toThrow(/model name/i);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("streams chunks through onChunk and returns the concatenated text", async () => {
    storeData = {
      openaiCompatBaseUrl: "https://api.example.com/v1",
      openaiCompatApiKey: "sk-test",
      openaiCompatModel: "gpt-4o-mini",
    };
    createSpy.mockResolvedValue(asyncIterFromArray([
      { id: "x", model: "gpt-4o-mini", choices: [{ delta: { content: "Hello" } }] },
      { id: "x", model: "gpt-4o-mini", choices: [{ delta: { content: " world" } }] },
      { id: "x", model: "gpt-4o-mini", choices: [{ delta: {} }] },
    ]));

    const chunks = [];
    let reportedModel = null;
    const out = await engine.streamImprove({
      text: "hi",
      systemPrompt: "be helpful",
      onChunk: c => chunks.push(c),
      onModel: m => { reportedModel = m; },
    });

    expect(out).toBe("Hello world");
    expect(chunks.join("")).toBe("Hello world");
    expect(reportedModel).toBe("gpt-4o-mini");
    // Reported model only once (the consumer uses it for the banner).
    expect(createSpy.mock.calls[0][0]).toMatchObject({
      model: "gpt-4o-mini",
      stream: true,
      messages: [
        { role: "system", content: "be helpful" },
        { role: "user", content: "hi" },
      ],
    });
  });

  it("strips a leading <think> block from the RETURNED text (matches OpenRouter/Groq behavior)", async () => {
    storeData = { openaiCompatBaseUrl: "https://api.example.com/v1", openaiCompatApiKey: "sk-test", openaiCompatModel: "reasoning" };
    createSpy.mockResolvedValue(asyncIterFromArray([
      { choices: [{ delta: { content: "<think>The user wants X. Let me write it.</think>" } }] },
      { choices: [{ delta: { content: "Hi there!" } }] },
    ]));
    const chunks = [];
    const out = await engine.streamImprove({
      text: "hi",
      systemPrompt: "be helpful",
      onChunk: c => chunks.push(c),
    });
    // The returned value must NOT contain the reasoning block.
    expect(out).toBe("Hi there!");
    // The chunks passed to onChunk keep the raw stream so the user sees typing
    // happen in real-time (filtering lives on the final value).
    expect(chunks.join("")).toContain("<think>");
  });

  it("works without an API key (placeholder is fine for keyless servers)", async () => {
    storeData = {
      openaiCompatBaseUrl: "http://localhost:1234/v1",
      openaiCompatModel: "local-model",
      // no openaiCompatApiKey
    };
    createSpy.mockResolvedValue(asyncIterFromArray([
      { choices: [{ delta: { content: "ok" } }] },
    ]));
    const out = await engine.streamImprove({ text: "hi", systemPrompt: "s" });
    expect(out).toBe("ok");
  });

  it("returns an empty-response error when the stream yields no content", async () => {
    storeData = { openaiCompatBaseUrl: "https://x/v1", openaiCompatModel: "m" };
    createSpy.mockResolvedValue(asyncIterFromArray([{ choices: [{ delta: {} }] }]));
    await expect(engine.streamImprove({ text: "hi", systemPrompt: "s" })).rejects.toThrow(/empty/i);
  });

  it("normalizes an SDK 401 into InvalidKeyError so the popup shows the key-rejected branch", async () => {
    storeData = { openaiCompatBaseUrl: "https://x/v1", openaiCompatApiKey: "bad", openaiCompatModel: "m" };
    createSpy.mockRejectedValue(Object.assign(new Error("Unauthorized"), { status: 401 }));
    await expect(engine.streamImprove({ text: "hi", systemPrompt: "s" })).rejects.toBeInstanceOf(errors.InvalidKeyError);
  });

  it("normalizes a generic TypeError into a NetworkError", async () => {
    storeData = { openaiCompatBaseUrl: "https://x/v1", openaiCompatModel: "m" };
    createSpy.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(engine.streamImprove({ text: "hi", systemPrompt: "s" })).rejects.toBeInstanceOf(errors.NetworkError);
  });
});

describe("fetchOpenAICompatibleModels", () => {
  it("returns [] when base URL is empty without fetching", async () => {
    expect(await fetchOpenAICompatibleModels("", "")).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns the data array on success", async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "gpt-4o-mini", owned_by: "openai" }, { id: "llama3" }] }) });
    const models = await fetchOpenAICompatibleModels("https://api.example.com/v1", "sk-x");
    expect(models.map(m => m.id)).toEqual(["gpt-4o-mini", "llama3"]);
    expect(models[0].owned_by).toBe("openai");
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/models");
    expect(init.headers.Authorization).toBe("Bearer sk-x");
    expect(init.signal).toBeDefined();
  });

  it("strips a trailing slash from the base URL before appending /models", async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    await fetchOpenAICompatibleModels("https://api.example.com/v1/", "");
    expect(global.fetch.mock.calls[0][0]).toBe("https://api.example.com/v1/models");
  });

  it("omits the Authorization header when no API key is provided", async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    await fetchOpenAICompatibleModels("http://localhost:11434/v1", "");
    expect(global.fetch.mock.calls[0][1].headers).toEqual({});
  });

  it("returns [] when reachable but the response has no recognizable list", async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    expect(await fetchOpenAICompatibleModels("https://x/v1", "")).toEqual([]);
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    expect(await fetchOpenAICompatibleModels("https://x/v1", "")).toEqual([]);
    global.fetch.mockResolvedValue({ ok: true, json: async () => { throw new Error("no json"); } });
    expect(await fetchOpenAICompatibleModels("https://x/v1", "")).toEqual([]);
  });

  it("filters out rows without a string id", async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "ok" }, {}, { id: 42 }, { id: "fine", owned_by: null }] }) });
    const models = await fetchOpenAICompatibleModels("https://x/v1", "");
    expect(models.map(m => m.id)).toEqual(["ok", "fine"]);
  });

  it("throws NetworkError when the provider can't be reached", async () => {
    global.fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(fetchOpenAICompatibleModels("https://x/v1", "")).rejects.toBeInstanceOf(errors.NetworkError);
  });

  it("throws NetworkError on a non-OK response", async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    await expect(fetchOpenAICompatibleModels("https://x/v1", "")).rejects.toBeInstanceOf(errors.NetworkError);
  });
});
