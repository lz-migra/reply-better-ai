// Groq model list with the same cache + fallback pattern as models-cache.js
// (OpenRouter). The Groq free tier only exposes a handful of models, but the
// user can still pick between fast 8B, balanced 70B, large-context Mixtral,
// Whisper (transcription only), etc. — so a picker beats a hardcoded default.
//
// Fetched lazily from GET /openai/v1/models (OpenAI-compatible schema). Same
// shape as the OpenRouter list: { models, stale, source, error }. Cached in
// storage.local under GROQ_MODELS_CACHE_KEY for GROQ_MODELS_TTL_MS.

import { storage } from "./storage.js";
import { GROQ_BASE, GROQ_MODELS_CACHE_KEY, GROQ_MODELS_TTL_MS } from "./constants.js";
import { NetworkError } from "./errors.js";

const MODELS_TIMEOUT_MS = 15000;

function isLiveModel(m) {
  if (!m || typeof m.id !== "string") return false;
  if (m.active === false) return false;
  return true;
}

export async function getGroqModels({ forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const { [GROQ_MODELS_CACHE_KEY]: cached } = await storage.get([GROQ_MODELS_CACHE_KEY]);
    if (cached?.models?.length && Date.now() - cached.cachedAt < GROQ_MODELS_TTL_MS) {
      return { models: cached.models, stale: false, source: "cache" };
    }
  }
  const { groqApiKey } = await storage.get(["groqApiKey"]);
  if (!groqApiKey) {
    // No key yet — return empty so the UI can prompt the user to add one
    // instead of firing a 401 fetch on every popup open.
    return { models: [], stale: false, source: "needs-key" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${GROQ_BASE}/models`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${groqApiKey}` },
    });
  } catch (e) {
    throw new NetworkError(e.name === "AbortError" ? "Timed out reaching Groq" : e.message);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new NetworkError(`Groq responded ${response.status}`);
  const body = await response.json().catch(() => null);
  const list = Array.isArray(body?.data) ? body.data : [];
  const models = list.filter(isLiveModel).map(m => ({
    id: m.id,
    owned_by: m.owned_by || null,
    context_window: typeof m.context_window === "number" ? m.context_window : null,
  }));
  if (models.length) {
    await storage.set({ [GROQ_MODELS_CACHE_KEY]: { models, cachedAt: Date.now() } });
  }
  return { models, stale: false, source: "fresh" };
}
