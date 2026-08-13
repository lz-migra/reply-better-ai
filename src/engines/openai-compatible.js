import OpenAI from "openai";
import { storage } from "../lib/storage.js";
import { OPENAI_COMPAT_DEFAULT_BASE_URL, REQUEST_TIMEOUT_MS } from "../lib/constants.js";
import { InvalidKeyError, NetworkError, OpenRouterError } from "../lib/errors.js";
import { cleanModelOutput } from "../lib/sanitize.js";

// Generic OpenAI-compatible engine. The user supplies their own base URL, API
// key, and model name — covering any provider that speaks the OpenAI Chat
// Completions schema (OpenAI, Together, Mistral, DeepSeek, Fireworks, vLLM,
// llama.cpp, etc.). Built on the official `openai` SDK so adding a new
// provider is just three text fields; the SDK already handles streaming SSE,
// and we route errors through the existing typed-error classes.

export function makeOpenAICompatibleEngine() {
  return {
    id: "openaicompat",
    label: "OpenAI-compatible (custom)",
    kind: "cloud",

    // "ready" only when both base URL and model are set — API key is optional
    // (some local / proxied servers are keyless). Like the local engine, we
    // don't ping the server here: availability() is on hot paths and a slow /
    // dead remote would block every generation.
    async availability() {
      const { openaiCompatBaseUrl, openaiCompatModel } = await storage.get(["openaiCompatBaseUrl", "openaiCompatModel"]);
      return openaiCompatBaseUrl && openaiCompatModel ? "ready" : "needs-setup";
    },

    async streamImprove({ text, systemPrompt, signal, onChunk, onModel }) {
      const { openaiCompatBaseUrl, openaiCompatApiKey, openaiCompatModel } = await storage.get([
        "openaiCompatBaseUrl",
        "openaiCompatApiKey",
        "openaiCompatModel",
      ]);
      if (!openaiCompatBaseUrl) throw new OpenRouterError("Set the base URL for your OpenAI-compatible provider in settings first.");
      if (!openaiCompatModel) throw new OpenRouterError("Set a model name in settings first.");

      const client = new OpenAI({
        apiKey: openaiCompatApiKey || "not-needed",
        baseURL: openaiCompatBaseUrl || OPENAI_COMPAT_DEFAULT_BASE_URL,
        // The SDK default is 10 min — too long for a chat completion that streams
        // tokens in well under a second for most providers. Cap aggressively.
        timeout: REQUEST_TIMEOUT_MS,
        dangerouslyAllowBrowser: true, // service-worker / popup context
      });

      let stream;
      try {
        stream = await client.chat.completions.create(
          {
            model: openaiCompatModel,
            stream: true,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: text },
            ],
          },
          { signal },
        );
      } catch (e) {
        throw normalizeError(e);
      }

      let full = "";
      let modelReported = false;
      try {
        for await (const chunk of stream) {
          const delta = chunk?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) {
            full += delta;
            onChunk?.(delta);
          }
          if (!modelReported && onModel && chunk?.model) {
            onModel(chunk.model);
            modelReported = true;
          }
        }
      } catch (e) {
        throw normalizeError(e);
      }
      if (!full) throw new OpenRouterError("Empty response from model");
      const cleaned = cleanModelOutput(full);
      if (!cleaned) throw new OpenRouterError("Empty response from model");
      return cleaned;
    },
  };
}

// Map SDK / network exceptions onto the project's typed errors so popup +
// inline panel keep their existing branches (InvalidKeyError → "your key was
// rejected", RateLimitError → "try again", NetworkError → "couldn't reach").
function normalizeError(e) {
  if (!e) return e;
  if (e.name === "AbortError") return new NetworkError("Request aborted");
  const status = e?.status ?? e?.response?.status;
  if (status === 401 || status === 403) return new InvalidKeyError(e?.message || "API key was rejected");
  if (status === 429) return new OpenRouterError("Rate limited — wait a moment, then try again.");
  if (status && status >= 400) return new OpenRouterError(`Provider responded ${status}: ${e?.message || "request failed"}`);
  if (e instanceof TypeError) return new NetworkError(e.message || "Network request failed");
  return e;
}

// User-initiated fetch of the available models from an OpenAI-compatible
// provider's standard GET /models endpoint. Same shape for every compatible
// server ({ data: [{ id }, …] }); we tolerate odd shapes by returning [].
// Off the hot path — never called from availability() or engine resolve(), so
// it's safe to spend full REQUEST_TIMEOUT_MS here.
const MODELS_TIMEOUT_MS = 15000;

export async function fetchOpenAICompatibleModels(baseUrl, apiKey) {
  if (!baseUrl) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      signal: controller.signal,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
  } catch (e) {
    throw new NetworkError(e.name === "AbortError" ? "Timed out reaching the provider" : e.message);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new NetworkError(`Provider responded ${response.status}`);
  const body = await response.json().catch(() => null);
  const list = Array.isArray(body?.data) ? body.data : [];
  return list.filter(m => m && typeof m.id === "string" && m.id).map(m => ({ id: m.id, owned_by: m.owned_by || null }));
}
