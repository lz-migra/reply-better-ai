import { cleanModelOutput } from "../lib/sanitize.js";
import { ProviderError } from "../lib/errors.js";

// Gemini Nano only accepts [de, en, es, fr, ja]; this is an English-first
// product, so we declare English on both input (system + user prompt) and
// output. Per the spec, the same options MUST be passed to availability() and
// create(), or Chrome silently mis-derives capability and prints the
// "No output/input language specified" warning.
const LANG_OPTIONS = Object.freeze({
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
});

// Chrome built-in AI (Gemini Nano) via the Prompt API. No key, runs on-device.
// `LanguageModel` is a global in extension contexts (service worker + extension
// pages); it's absent elsewhere (Firefox, page/content context) -> "unsupported".
export const onDeviceEngine = {
  id: "ondevice",
  label: "On-device · free",
  kind: "on-device",

  async availability() {
    if (typeof LanguageModel === "undefined") return "unsupported";
    try {
      const a = await LanguageModel.availability(LANG_OPTIONS);
      if (a === "available") return "ready";
      if (a === "downloadable" || a === "downloading") return "downloadable";
      return "unsupported";
    } catch {
      return "unsupported";
    }
  },

  async streamImprove({ text, systemPrompt, signal, onChunk }) {
    if (typeof LanguageModel === "undefined") throw new ProviderError(0, "On-device AI is unavailable");
    const session = await LanguageModel.create({
      ...LANG_OPTIONS,
      initialPrompts: [{ role: "system", content: systemPrompt }],
    });
    try {
      let full = "";
      const stream = session.promptStreaming(text); // chunks are deltas (confirmed in the POC)
      for await (const chunk of stream) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        full += chunk;
        onChunk?.(chunk);
      }
      const cleaned = cleanModelOutput(full);
      if (!cleaned) throw new ProviderError(0, "Empty on-device response");
      return cleaned;
    } finally {
      session.destroy();
    }
  },
};
