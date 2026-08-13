import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

vi.mock("../src/lib/browser.js", () => ({
  default: {
    storage: {
      local: { get: vi.fn().mockResolvedValue({}), set: vi.fn(), remove: vi.fn() },
      sync: { get: vi.fn().mockResolvedValue({}), remove: vi.fn() },
    },
  },
}));

// storage.get can be overridden per test to return the right keys.
let storeData = {};
const { resolveEngineId, engineKeyVisibility, engineUsesModelPicker, engineModelSummary, ENGINES, hasAnyUsableEngine } = await import("../src/engines/index.js");

// Replace storage.get for tests that care (the module captures storage at
// import time; re-mock its `get` to consult our local storeData instead).
const storageMod = await import("../src/lib/storage.js");
storageMod.storage.get = async keys => {
  const ks = Array.isArray(keys) ? keys : [keys];
  return Object.fromEntries(ks.filter(k => k in storeData).map(k => [k, storeData[k]]));
};

const { onDeviceEngine } = await import("../src/engines/ondevice.js");

describe("resolveEngineId", () => {
  it("honors an explicit, registered engine setting", () => {
    expect(resolveEngineId({ engineSetting: "openrouter", onDeviceAvail: "ready", hasGroqKey: true, hasOpenRouterKey: true })).toBe("openrouter");
  });

  it("auto prefers on-device when available", () => {
    expect(resolveEngineId({ engineSetting: "auto", onDeviceAvail: "ready", hasGroqKey: true, hasOpenRouterKey: true })).toBe("ondevice");
    expect(resolveEngineId({ engineSetting: "auto", onDeviceAvail: "downloadable", hasGroqKey: false, hasOpenRouterKey: false })).toBe("ondevice");
  });

  it("auto falls to groq when on-device unsupported and a groq key exists", () => {
    expect(resolveEngineId({ engineSetting: "auto", onDeviceAvail: "unsupported", hasGroqKey: true, hasOpenRouterKey: false })).toBe("groq");
  });

  it("auto falls to openrouter otherwise", () => {
    expect(resolveEngineId({ engineSetting: "auto", onDeviceAvail: "unsupported", hasGroqKey: false, hasOpenRouterKey: true })).toBe("openrouter");
    expect(resolveEngineId({ engineSetting: "auto", onDeviceAvail: "unsupported", hasGroqKey: false, hasOpenRouterKey: false })).toBe("openrouter");
  });

  it("honors an explicit on-device setting (now registered)", () => {
    expect(resolveEngineId({ engineSetting: "ondevice", onDeviceAvail: "ready", hasGroqKey: false, hasOpenRouterKey: true })).toBe("ondevice");
  });

  it("honors an explicit local setting", () => {
    expect(resolveEngineId({ engineSetting: "local", onDeviceAvail: "unsupported", hasGroqKey: false, hasOpenRouterKey: false })).toBe("local");
  });

  it("never resolves local from auto (local is opt-in only)", () => {
    expect(resolveEngineId({ engineSetting: "auto", onDeviceAvail: "unsupported", hasGroqKey: false, hasOpenRouterKey: false })).not.toBe("local");
  });
});

describe("engineKeyVisibility", () => {
  it("ondevice shows no key fields", () => {
    expect(engineKeyVisibility("ondevice")).toEqual({ groq: false, openrouter: false });
  });
  it("local shows no key fields (keyless)", () => {
    expect(engineKeyVisibility("local")).toEqual({ groq: false, openrouter: false });
  });
  it("groq shows only the Groq field", () => {
    expect(engineKeyVisibility("groq")).toEqual({ groq: true, openrouter: false });
  });
  it("openrouter shows only the OpenRouter field", () => {
    expect(engineKeyVisibility("openrouter")).toEqual({ groq: false, openrouter: true });
  });
  it("auto (and unknown) shows both", () => {
    expect(engineKeyVisibility("auto")).toEqual({ groq: true, openrouter: true });
    expect(engineKeyVisibility(undefined)).toEqual({ groq: true, openrouter: true });
  });
});

describe("engineUsesModelPicker", () => {
  it("shows the model picker for openrouter and auto", () => {
    expect(engineUsesModelPicker("openrouter")).toBe(true);
    expect(engineUsesModelPicker("auto")).toBe(true);
    expect(engineUsesModelPicker(undefined)).toBe(true);
  });
  it("hides it for engines with their own model", () => {
    expect(engineUsesModelPicker("ondevice")).toBe(false);
    expect(engineUsesModelPicker("groq")).toBe(false);
    expect(engineUsesModelPicker("local")).toBe(false);
  });
});

describe("engineModelSummary", () => {
  it("describes the fixed-model engines", () => {
    expect(engineModelSummary("ondevice")).toMatch(/Gemini Nano/);
    expect(engineModelSummary("groq")).toMatch(/Groq/);
  });
  it("returns null for picker engines and for local (resolved by the caller)", () => {
    expect(engineModelSummary("openrouter")).toBe(null);
    expect(engineModelSummary("auto")).toBe(null);
    expect(engineModelSummary("local")).toBe(null);
  });
});

describe("onDeviceEngine.availability", () => {
  afterEach(() => { delete globalThis.LanguageModel; });

  it("returns unsupported when LanguageModel is absent", async () => {
    delete globalThis.LanguageModel;
    expect(await onDeviceEngine.availability()).toBe("unsupported");
  });

  it("maps Chrome availability states", async () => {
    globalThis.LanguageModel = { availability: async () => "available" };
    expect(await onDeviceEngine.availability()).toBe("ready");
    globalThis.LanguageModel = { availability: async () => "downloadable" };
    expect(await onDeviceEngine.availability()).toBe("downloadable");
    globalThis.LanguageModel = { availability: async () => "unavailable" };
    expect(await onDeviceEngine.availability()).toBe("unsupported");
  });

  it("treats a thrown availability() as unsupported", async () => {
    globalThis.LanguageModel = { availability: async () => { throw new Error("boom"); } };
    expect(await onDeviceEngine.availability()).toBe("unsupported");
  });

  it("passes language options to availability() so Chrome doesn't warn about an undeclared output language", async () => {
    const availability = vi.fn(async () => "available");
    globalThis.LanguageModel = { availability };
    await onDeviceEngine.availability();
    expect(availability).toHaveBeenCalledWith({
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
    });
  });
});

describe("cloud engines registry", () => {
  it("registers ondevice, groq, openrouter, local, and openaicompat", () => {
    expect(Object.keys(ENGINES).sort()).toEqual(["groq", "local", "ondevice", "openaicompat", "openrouter"]);
    expect(ENGINES.groq.kind).toBe("cloud");
    expect(ENGINES.openrouter.kind).toBe("cloud");
    expect(ENGINES.ondevice.kind).toBe("on-device");
    expect(ENGINES.local.kind).toBe("local");
    expect(ENGINES.openaicompat.kind).toBe("cloud");
  });

  it("groq reports needs-setup when no key is stored", async () => {
    expect(await ENGINES.groq.availability()).toBe("needs-setup");
  });

  it("openaicompat reports needs-setup when base URL or model is missing", async () => {
    expect(await ENGINES.openaicompat.availability()).toBe("needs-setup");
  });
});

describe("openaicompat in selectors", () => {
  it("honors an explicit openaicompat setting", () => {
    expect(resolveEngineId({ engineSetting: "openaicompat", onDeviceAvail: "ready", hasGroqKey: true, hasOpenRouterKey: true })).toBe("openaicompat");
  });

  it("never resolves openaicompat from auto (opt-in only)", () => {
    expect(resolveEngineId({ engineSetting: "auto", onDeviceAvail: "unsupported", hasGroqKey: false, hasOpenRouterKey: false })).not.toBe("openaicompat");
  });

  it("hides both key fields for openaicompat (configured in its own card)", () => {
    expect(engineKeyVisibility("openaicompat")).toEqual({ groq: false, openrouter: false });
  });

  it("does not show the OpenRouter model picker for openaicompat", () => {
    expect(engineUsesModelPicker("openaicompat")).toBe(false);
  });
});

describe("hasAnyUsableEngine", () => {
  beforeEach(() => { storeData = {}; delete globalThis.LanguageModel; });

  it("returns false with no on-device support and no keys", async () => {
    expect(await hasAnyUsableEngine()).toBe(false);
  });

  it("returns true when a Groq key is present", async () => {
    storeData = { groqApiKey: "gsk_x" };
    expect(await hasAnyUsableEngine()).toBe(true);
  });

  it("returns true when an OpenRouter key is present", async () => {
    storeData = { apiKey: "sk-or-x" };
    expect(await hasAnyUsableEngine()).toBe(true);
  });

  it("returns true when on-device is ready, even with no keys", async () => {
    globalThis.LanguageModel = { availability: async () => "available" };
    expect(await hasAnyUsableEngine()).toBe(true);
  });

  // Regression for the bug this PR fixed: a user configured only an
  // OpenAI-compatible provider kept seeing "Add your OpenRouter API key".
  it("returns true when openaicompat has base URL + model set", async () => {
    storeData = { openaiCompatBaseUrl: "https://api.openai.com/v1", openaiCompatModel: "gpt-4o-mini" };
    expect(await hasAnyUsableEngine()).toBe(true);
  });

  it("returns false when openaicompat is only partially configured (base URL without model)", async () => {
    storeData = { openaiCompatBaseUrl: "https://api.openai.com/v1" };
    expect(await hasAnyUsableEngine()).toBe(false);
  });

  it("returns false when openaicompat has only the model (no base URL)", async () => {
    storeData = { openaiCompatModel: "gpt-4o-mini" };
    expect(await hasAnyUsableEngine()).toBe(false);
  });
});
