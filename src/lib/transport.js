// Transport abstraction so the content script can run in either a WebExtension
// (talks to the service worker via chrome.runtime.sendMessage / runtime.connect)
// or a Tampermonkey userscript (talks directly to the model API from page
// context). The content script only depends on:
//
//   transport.stream({ payload, onDelta, onModel, signal }) → Promise<string>
//   transport.getSettings()                                  → Promise<settings>
//
// The wiring for each runtime is in `createExtensionTransport` and
// `createUserscriptTransport`.

import { streamImproveText } from "./openrouter.js";

// ── Extension transport ─────────────────────────────────────────────────────
//
// Routes through the background service worker, which holds API keys and
// streams responses back over a port.

function getBrowser() {
  if (typeof globalThis.browser === "undefined" && typeof globalThis.chrome === "undefined") {
    throw new Error("EXT_CONTEXT_INVALIDATED");
  }
  return globalThis.browser || globalThis.chrome;
}

export function createExtensionTransport() {
  return {
    kind: "extension",
    async getSettings() {
      const browser = getBrowser();
      if (!browser?.runtime?.id) throw new Error("EXT_CONTEXT_INVALIDATED");
      const res = await browser.runtime.sendMessage({ action: "getSettings" });
      if (res?.error) throw new Error(res.error);
      return res?.settings || {};
    },
    stream({ payload, onDelta, onModel, signal }) {
      if (!getBrowser()?.runtime?.id) return Promise.reject(new Error("EXT_CONTEXT_INVALIDATED"));
      return new Promise((resolve, reject) => {
        let port;
        try { port = getBrowser().runtime.connect({ name: "rb-improve-stream" }); }
        catch (e) { reject(e); return; }
        let settled = false;
        const finish = () => { try { port.disconnect(); } catch {} };
        port.onMessage.addListener(msg => {
          if (msg.delta) onDelta?.(msg.delta);
          else if (msg.model) onModel?.(msg.model);
          else if (msg.done) { settled = true; resolve(msg.full); finish(); }
          else if (msg.error) { settled = true; const err = new Error(msg.error); err.code = msg.code; reject(err); finish(); }
        });
        port.onDisconnect.addListener(() => {
          if (!settled) reject(new Error("EXT_CONTEXT_INVALIDATED"));
        });
        signal?.addEventListener("abort", () => { if (!settled) { settled = true; finish(); reject(new DOMException("Aborted", "AbortError")); } });
        try { port.postMessage({ action: "stream", ...payload }); }
        catch (e) { reject(e); finish(); }
      });
    },
  };
}

// ── Userscript transport ────────────────────────────────────────────────────
//
// In a userscript the page can hit the API directly. Settings come from GM_*Value
// (via the storage adapter) and the OpenAI-compatible path streams from page
// context.

const ENGINE_BASE = {
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
};

// Normalise an OpenAI-compatible base URL: trim trailing slash, prepend
// https:// when the user wrote "host:port" without a scheme, drop a trailing
// "/v1" if present so we can append "/chat/completions" deterministically.
function sanitizeApiBase(url) {
  if (!url) return "";
  let u = String(url).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return u.replace(/\/v1$/i, "");
}

export function resolveBaseUrl(engine, settings) {
  if (engine === "openrouter") return ENGINE_BASE.openrouter;
  if (engine === "groq") return ENGINE_BASE.groq;
  if (engine === "openai-compatible") {
    const base = sanitizeApiBase(settings.openaiCompatBaseUrl);
    if (!base) throw new Error("Set the API base URL in the Reply Better options first.");
    return base;
  }
  throw new Error(`Unknown engine: ${engine}`);
}

export function createUserscriptTransport({ getSettings }) {
  return {
    kind: "userscript",
    async getSettings() { return getSettings(); },
    async stream({ payload, onDelta, onModel, signal }) {
      const settings = await getSettings();
      const engine = payload.engine || settings.engine || "openrouter";
      if (engine === "ondevice") {
        throw new Error("On-device engine is only available in the browser extension.");
      }
      const baseUrl = await resolveBaseUrl(engine, settings);
      const models = engine === "openai-compatible" ? (settings.openaiCompatModels || []) : undefined;
      return streamImproveText({
        text: payload.text,
        apiKey: payload.apiKey,
        model: payload.model,
        models,
        systemPrompt: payload.systemPrompt,
        baseUrl,
        signal,
        onChunk: onDelta,
        onModel,
      });
    },
  };
}
