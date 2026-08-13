# AGENTS.md

Compact index for agent sessions. For full rationale read the linked docs.

## Project shape

- Manifest V3 WebExtension, one ES-module source tree bundled for two browsers.
- Source: `src/`. Build output: `dist/chrome/` and `dist/firefox/` (gitignored). Never edit `dist/`.
- Four bundled entries, each a separate surface: `background/service-worker.js`, `content/index.js`, `popup/index.js`, `options/index.js`. esbuild target is `chrome109` / `firefox115`; the Firefox manifest's `strict_min_version` is **140** (Android 142) and Chrome's `minimum_chrome_version` is **109**.
- Surfaces must not import across each other. Shared code lives in `src/lib/`. The only cross-surface channels are `runtime.sendMessage` (one-shot requests), `runtime.connect` (streaming relay on the port `rb-improve-stream`), and `storage.onChanged` (settings broadcast).
- Runtime deps: `webextension-polyfill` (cross-browser API seam) and `openai` (used by the `openaicompat` engine — keep `dangerouslyAllowBrowser: true`).

### Engines — the heart of the extension

`src/engines/index.js` exports a registry of **five** engines:

| id | kind | Storage keys | Source |
|----|------|--------------|--------|
| `ondevice` | `on-device` | — | Chrome's `LanguageModel` Prompt API (Gemini Nano) |
| `groq` | `cloud` | `groqApiKey`, `groqQuota` | `engines/cloud.js` (OpenAI-compatible, user key) |
| `openrouter` | `cloud` | `apiKey`, `model`, `modelsCache`, `modelFallbackNotice` | `engines/cloud.js` (OpenAI-compatible, user key) |
| `local` | `local` | `localBaseUrl`, `localModel`, `localPreset` | `engines/local.js` (Ollama / LM Studio / llama.cpp / vLLM) |
| `openaicompat` | `cloud` | `openaiCompatBaseUrl`, `openaiCompatApiKey`, `openaiCompatModel` | `engines/openai-compatible.js` (any OpenAI Chat-Completions server) |

Each engine exposes the same shape: `id`, `label`, `kind`, `async availability()`, `async streamImprove({ text, systemPrompt, signal, onChunk, onModel })`. Add a new engine by extending this contract; the rest of the codebase reads it generically via `resolveEngineId`, `engineKeyVisibility`, `engineUsesModelPicker`, `engineModelSummary`, `engineQuotaText`, and `orderedEngines`.

Three rules that come back to bite:

1. **`availability()` is on hot paths** (every popup open, every stream start). It must be a pure storage read. A `fetch` here would block every generation when a remote is slow or dead. Defer reachability to a user-initiated probe (`listLocalModels`, `fetchOpenAICompatibleModels`).
2. **`local` and `openaicompat` are opt-in only.** They never appear in `resolveEngineId`'s fallback cascade and never appear in `orderedEngines()` as Auto fallback. A user must pick them explicitly. Don't "fix" this by adding them to auto.
3. **`orderedEngines()` retries the next engine only before any output has streamed.** Once a chunk has been sent to the client, the worker stops trying alternatives. Never double-stream a partial result.

`Auto · Fastest free` is a sentinel model id (`auto:fastest-free`) the user can pick in the model picker. The openrouter engine resolves it to a `models: [...]` array at request time (reasoning models excluded, popular ones first, capped at `AUTO_FREE_MODEL_LIMIT`). OpenRouter picks the fastest and fails over automatically on error.

`validateSelectedModel` returns `{ valid: true, deferred: true }` when there's no live list and no cache — defer the verdict rather than asserting "all good" so a flapping network doesn't silently accept a missing model. The startup validation runs from `onInstalled` and `onStartup` and rewrites `model` to the fallback plus sets `modelFallbackNotice` if the saved model is gone; any successful revalidation must clear that notice.

### Layout

```
src/
├── background/service-worker.js   # message router, install/startup, stream relay
├── content/                        # injected into every http(s) page
│   ├── index.js                    # orchestrator: focus/blur, mode detection
│   ├── button-injector.js          # the morphing Reply/Improve button + toasts
│   ├── panel.js                    # inline reply/improve panel: chips, diff, model switch
│   ├── snippet-expander.js         # TextBlaze-style trigger expansion
│   ├── text-target.js              # textarea/contentEditable detection helpers
│   ├── content-button.css          # injected styles (theme-independent)
│   └── reply-mode.css              # reply-panel additions
├── popup/                          # toolbar popup (one bundled entry)
│   ├── index.js
│   ├── popup.html / popup.css / model-picker.css
│   └── components/                 # ModelPicker.js, settings-ui.js, ModelListModal.js
├── options/                        # full-tab settings page (one bundled entry)
│   ├── index.js
│   └── options.html / options.css
├── lib/                            # shared (background + popup + options)
│   ├── browser.js                  # webextension-polyfill re-export
│   ├── constants.js                # all magic strings & numbers
│   ├── errors.js                   # typed errors + fromResponse()
│   ├── storage.js                  # chrome.storage.local adapter + migrations
│   ├── openrouter.js               # OpenAI-compatible streaming client
│   ├── models-cache.js             # 1h TTL model list + validation + display
│   ├── system-prompts.js           # style prompts + reply-mode prompt builder
│   ├── sanitize.js                 # strips reasoning blocks + chatty wrappers
│   ├── diff.js                     # word-level LCS diff (capped at 2500 tokens)
│   └── transport.js                # extension ↔ userscript transport abstraction
├── shared/tokens.css               # design tokens + dark theme
└── data/popular-models.js          # curated "Popular" tab list
```

### Userscript runtime

The same content-tree compiles to a Tampermonkey userscript. `src/lib/transport.js` defines a transport abstraction (`createExtensionTransport` for the extension, `createUserscriptTransport` for the userscript). The content script only depends on `transport.stream({ payload, onDelta, onModel, signal })` and `transport.getSettings()`. Any new cross-runtime feature must keep that contract.

The content script auto-bootstraps at module load: if `globalThis.__RB_TRANSPORT__` and `globalThis.__RB_STORAGE__` are set (userscript runtime), it uses them; otherwise it constructs `createExtensionTransport()` + `createStorage(chromeBackend)` inline. The `window.__RB_BOOTSTRAPPED__` flag guards against double-init. Don't add a third path — these two cover everything.

## Commands

- `npm run build` — bundles both browsers into `dist/`. Use this; there is no other build path.
- `npm run watch` — rebuild on save (sourcemaps inline).
- `npm run package` — zips both `dist/` for store submission. Requires `zip` on PATH.
- `npm test` — vitest run, one-shot. `npm run test:watch` for watch mode.
- `node` must be ≥18 (enforced in `package.json`).
- No linter / formatter / typechecker is configured. Do not add one without a discussion.

## Load the built extension

- Chrome: load `dist/chrome/` unpacked via `chrome://extensions` → Developer mode. Minimum Chrome **109**.
- Firefox: load `dist/firefox/` via `about:debugging` → This Firefox → Load Temporary Add-on. Minimum Firefox **140** (Android 142).

## Manifest pair

Chrome and Firefox MV3 disagree on background form. Two manifests exist: `manifest.chrome.json` and `manifest.firefox.json`. **Edit both in the same commit.** `build.mjs` copies the right one into `dist/<browser>/manifest.json`. New `permissions` / `host_permissions` / `strict_min_version` / `data_collection_permissions` entries need a one-line justification in the commit body / PR description.

The Firefox manifest also requires `browser_specific_settings.gecko.data_collection_permissions` declaring exactly what the extension collects (today: `authenticationInfo`, `personalCommunications`, `websiteContent` because the content script reads `value` from focused inputs). Don't add this block to the Chrome manifest — Chrome rejects it.

Current `host_permissions`:
- `https://openrouter.ai/*` — OpenRouter API
- `https://api.groq.com/*` — Groq API
- `http://localhost/*` and `http://127.0.0.1/*` — local LLM servers

Adding a new host means editing both manifests. The `description` field is intentionally per-browser (marketing copy targeted at each store) — keep truth, not the exact text, in sync.

## Service worker gotcha (Chrome MV3)

Async `browser.runtime.onMessage` handlers **must `return true` synchronously** and resolve later via `sendResponse`. Returning a Promise directly silently drops the response on Chrome. Firefox is more forgiving but write to the stricter rule.

`browser.runtime.onConnect` listeners do **not** need `return true` — they're ports, not request/response. Their inner `port.onMessage.addListener` is async-friendly out of the box.

No long-lived in-memory state in the service worker; it idles and restarts. Cache via `storage.local` or accept the loss. Models cache, quota, fallback notice — all in `storage.local`.

## Conventions the agent is likely to violate

These are not optional and the coding-standards docs spell out the *why*:

- **Never reference `chrome.*` / `browser.*` directly in source.** Always `import browser from "./lib/browser.js"` (webextension-polyfill seam).
- **Never `storage.sync` for secrets.** API keys live in `storage.local` only. `migrateFromSync` in `src/lib/storage.js` cleans up v1 leftovers.
- **Never `alert()`.** Surface errors via `showToast` (content), `showBanner` (popup), `showStatus` (options).
- **Throw typed errors from `src/lib/errors.js`.** Use the `fromResponse(response, body)` factory; don't construct typed errors from raw status codes.
- **Never assign to `innerHTML` / `outerHTML` / `insertAdjacentHTML`** with anything that isn't a hardcoded literal. Page content and model output are treated as untrusted.
- **No `eval`, no `Function()` constructor, no inline `<script>` in HTML.** CSP (`script-src 'self'`) enforces this; don't work around it by adding an inline handler to popup.html or options.html.
- **API key never appears in `console.log/warn/error`.** Ever. Not even temporarily.
- **Content script MUST NOT hold the API key or make network calls.** Routes through the service worker via `runtime.sendMessage` (one-shot) or `runtime.connect` (streaming).
- **No `availability()` with network calls.** Hot paths; a slow remote blocks every stream.
- **No `local` / `openaicompat` in the auto cascade.** They're opt-in only by design.
- **No speculative permissions.** Each `permissions` / `host_permissions` entry must trace to a concrete call.
- **No comments unless WHY is non-obvious.** One line max. Code-review-enforced style.
- **Vanilla JS, no framework, no TypeScript.** Don't add React/Vue/Svelte/TS deps. The runtime deps are `webextension-polyfill` and `openai` (the latter is required for the OpenAI-compatible engine — keep `dangerouslyAllowBrowser: true`).
- **One source of truth for repeated strings** → `src/lib/constants.js` or `src/data/popular-models.js`.
- **Coerce model-output data through `cleanModelOutput`** before it reaches the DOM. It strips reasoning blocks (`<think>`, `<reasoning>`, `<thought>`, Harmony tokens) and chatty wrappers. Don't bypass it for "obvious" outputs.
- **CSS prefix discipline** — `reply-better-` for content-script injected styles, `rb-` for popup/options internals, `mp-` for the model picker. No `!important` unless a host page would otherwise win.

## Content-script patterns

These trip up new contributors more than any other category:

- **Concurrency tokens in streaming UI.** When a second stream supersedes a first (user switches model, clicks Regenerate, picks a different tone), the old stream's late chunks must not overwrite the new run. Pattern: `runToken` integer that increments on every `run()`; every chunk arrival and `finally` block checks `if (myToken !== runToken) return;` before touching the DOM.
- **`EXT_CONTEXT_INVALIDATED`.** After an extension reload, `browser.runtime.id` and `sendMessage`/`connect` calls throw. Surface the literal string `"EXT_CONTEXT_INVALIDATED"` so the panel can show "Extension was reloaded. Refresh this page." Don't swallow it as a generic error.
- **Always clean up the port.** `port.onDisconnect` is the only reliable signal that the panel closed mid-stream. The SW must `controller.abort()` on disconnect so it doesn't keep streaming (and billing) into the void. The client must `port.disconnect()` in `finally` (or every open leaks a port in the listener chain).
- **`storage.onChanged` listeners must be removed on `pagehide`.** Long-lived pages (Gmail, Twitter/X) otherwise accumulate listeners on every navigation. Use `{ once: true }` so the cleanup can't be forgotten.
- **Position-against-detached-field.** `getBoundingClientRect()` of a removed field returns zeros and `(0, 0)` collapses the button. Bail on `!field.isConnected || (rect.width === 0 && rect.height === 0)`.
- **`EXCLUDED_INPUT_TYPES`** in `src/content/text-target.js` is the drop list (password, hidden, button-like, pickers, number, checkbox, radio, file, range, etc.). Single-line text inputs (`search`, `email`, `url`, `tel`) are intentionally NOT excluded — they show the rewrite button. Don't widen the list without a reason.
- **`isTextInput` vs `isEditableForMenu`** — two slightly different gates. `isTextInput` mirrors the native spellcheck (respects `spellcheck="false"`) and gates the inline button. `isEditableForMenu` ignores `spellcheck="false"` and gates the context-menu flow — the user explicitly chose to rewrite, which overrides the page's opt-out. `disabled` and `readOnly` are hard blocks in both. Don't collapse them.
- **Reasoning models need cleanup, not preservation.** Qwen3 / DeepSeek-R1 / GPT-OSS / Kimi-K2 emit a tagged chain-of-thought block before the user-visible reply. `cleanModelOutput` deliberately strips every variant (`<think>...</think>`, `<|reasoning|>...</|/reasoning|>`, `<reasoning>...</reasoning>`, `<thought>...</thought>`). Don't "fix" the sanitizer to keep reasoning, even if a specific model "should" handle it.

## CSS prefix

- `reply-better-` — content-script injected styles (avoids host-page collisions).
- `rb-` — popup / options internal classes (e.g. `rb-banner`, `rb-spinner`, `rb-segmented`).
- `mp-` — model picker internal classes.

No `!important` unless a host page would otherwise win.

## Context-menu flow

The right-click "Help me write or rewrite" entry is registered in `src/background/service-worker.js` (`registerContextMenu()` on `onInstalled` + `onStartup`; Chrome MV3 keeps the menu across SW restarts). The SW click handler forwards via `tabs.sendMessage` to the content script, which runs `openFromContextMenu(selectionText)`.

Five gotchas that bit us in production:

1. **Chrome collapses `window.getSelection()` before showing the native menu**, so by the time our onMessage fires the selection is empty. We capture the right-click target on a capture-phase `contextmenu` listener (`handleContextMenu`) and store `{ field, selectedText, at }` in `lastContextMenu`. The snapshot expires after 5s so stale captures don't win against a fresh click.
2. **Sites like Google re-focus and collapse the selection in their own contextmenu handlers**, so `selectedText` may be empty even when the user clicked on a textarea with text in it. Capture `event.target` (the field) unconditionally; treat the selection as optional.
3. **Don't filter by `spellcheck="false"` in the context-menu path** — use `isEditableForMenu`, not `isTextInput`. Google's search `<textarea>` sets `spellcheck="false"` because it handles its own grammar. That opt-out is for the inline button, not a veto on explicit user actions from Chrome's own menu.
4. **Always `ensureButton` before any `openPanel` call** — the inline button may not exist yet (the user never focused the field). `ensureButton` is idempotent; `getButton` returning `null` causes silent aborts that look like "menu does nothing".
5. **Selection-mode vs whole-field-mode.** If the snapshot captured a non-empty `selectedText`, `openPanelForSelection` opens the panel with `draft: selectedText` and on Insert replaces only that range (preserves surrounding text; undo restores the original selection). Otherwise `openPanelFor` improves the whole field.

## Writing text — React/Vue, rich-text editors, undo buffer

`writeText` in `src/content/text-target.js` has to look like a real keystroke or the receiving app rejects the change silently. Three layers, with a fallback each:

- **`<input>` / `<textarea>`:** Use the prototype's native `value` setter (`HTMLInputElement.prototype` / `HTMLTextAreaElement.prototype`), not `element.value = …`. React, Vue and Angular install their own tracked setter on the element instance to mirror the value into their virtual DOM; bypassing it via the prototype setter updates the framework's state as if the user had typed. Also dispatch both `input` and `change`.
- **contentEditable — preferred:** `document.execCommand("insertText", …)`. Deprecated in the spec but still the only path that integrates with the browser's native undo buffer so `Ctrl+Z` works — same trick Grammarly and LanguageTool rely on.
- **contentEditable — fallback if execCommand returns false or throws:** Mutate the DOM directly via `range.deleteContents()` + `range.insertNode(document.createTextNode(value))` on the live selection's range (preserves the cursor). Synthesized events only notify listeners; they don't mutate, so always do the mutation first, then dispatch a synthesized `InputEvent` (`inputType: "insertText"`) so the framework sees the change. Tests + legacy browsers: fall back to a plain `Event("input", { … })` with `inputType` attached as a property.

## Diff budget

`src/lib/diff.js` runs an O(n*m) LCS — fine for typical rewrites, catastrophic past ~2500 tokens (the popup tab dies building the dp matrix). Above `MAX_DIFF_TOKENS` we return a coarse "all replaced" diff instead. Don't remove the cap without a replacement strategy.

## Coding standards (read these before opening a PR)

In order, in [`docs/coding-standards/`](./docs/coding-standards/):

1. [`architecture.md`](./docs/coding-standards/architecture.md) — layout, build, manifest pair, MV3 lifecycle
2. [`javascript-style.md`](./docs/coding-standards/javascript-style.md) — naming, modules, comments, async/DOM
3. [`error-handling.md`](./docs/coding-standards/error-handling.md) — typed errors, fail-closed, discriminated returns
4. [`security.md`](./docs/coding-standards/security.md) — permissions, content-script isolation, secrets
5. [`testing.md`](./docs/coding-standards/testing.md) — vitest patterns, mocking polyfill, behavioural not implementation-coupled

## Testing quick reference

- `webextension-polyfill` is mocked in every test file that touches it: `vi.mock("../src/lib/browser.js", () => ({ default: { storage: { local: { get/set/remove }, sync: { get/remove } } } }))`. See `tests/models-cache.test.js` for the stateful-storage variant.
- `global.fetch = vi.fn()` per test, reset in `beforeEach`.
- Test the contract, not the implementation. If a refactor that preserves observable behaviour breaks a test, the test was wrong.
- New branches in error mapping, caching, engine registration, sanitisation, pricing → add a test. DOM rendering, button injection, service-worker install wiring → smoke-tested manually, not unit-tested.
- Eleven test files today: `diff`, `engines`, `errors`, `local`, `models-cache`, `openai-compatible`, `openrouter`, `sanitize`, `snippet-expander`, `system-prompts`, `text-target`. Each module under `src/lib/` and `src/engines/` should have a peer in `tests/` if it has branches.

## Commit / PR conventions

- Conventional Commits: `feat`, `fix`, `refactor`, `chore`, `test`, `docs`. No `Closes #N` in the subject; that belongs in the PR description.
- Pre-PR: `npm run build` (no warnings on either browser) and `npm test` (green). Manual smoke test on at least one browser before merging.
- One logical change per commit. Each commit should read cleanly in `git diff main..HEAD`.
- Bumping `version` in `package.json` requires updating **both** manifest files in the same commit.

## Common agent traps

- Editing `dist/` instead of `src/`. The build wipes and rebuilds `dist/` — your edits are lost.
- Adding a host to only one of the two manifests.
- Returning a Promise from `onMessage` without `return true` — silent response drop on Chrome.
- Putting a `fetch` inside `availability()` — kills every stream.
- Adding `local` or `openaicompat` to the auto cascade — they're opt-in only.
- Logging the API key "just to debug" — commit it and you've disclosed.
- Adding `innerHTML` for "convenience" with model output — XSS by way of a compromised upstream.
- Reaching for `storage.sync` because "users want their key everywhere" — it's the wrong threat model; see security doc.
- Importing from `chrome.*` directly — breaks Firefox parity silently.
- Writing multi-line comments or docstrings — out of style; review will flag.
- Forgetting `runToken` in a new streaming UI — late chunks clobber the active run.
- Letting `activePort` leak across panel opens — every stream adds a port to the listener chain.
- Adding a new engine without updating `resolveEngineId`, `engineKeyVisibility`, `engineUsesModelPicker`, `engineModelSummary`, `engineQuotaText`, `orderedEngines` — those are the minimum generic helpers that read the registry.
- Adding `data_collection_permissions` to the Chrome manifest — Chrome rejects it.
- Forgetting `strict_min_version` in the Firefox manifest — AMO rejects without it.
- Treating `modelFallbackNotice` as durable state — clear it on a successful `validateSelectedModel` or the banner reappears forever.
- Forgetting `port.disconnect()` on the success path — the next `connect` may race against a still-open port and trip the listener chain.
- Treating `validateApiKey` as boolean — its return is `{ ok: true } | { ok: false, reason: "invalid" | "timeout" | "network" | "provider" }`. Caller branches on `reason` to either refuse (invalid) or save and warn (timeout/network).
- Reading the API key in the content script "just to know whether to show the button" — the content script never sees it. Use `hasAnyUsableEngine()` instead.
- Adding inline `<script>` to popup.html or options.html to "save a round-trip" — the CSP rejects it. Bundle into the JS entry.
- **Filtering by `spellcheck="false"` in the context-menu path** — the menu must work on Google search etc. Use `isEditableForMenu`, not `isTextInput`.
- **Calling `getButton()` and bailing on `null` inside `openPanelFor`/`openPanelForSelection`** — silent failure. Always `ensureButton(onButtonClick)` first; it's idempotent.
- **Trusting `window.getSelection()` in the context-menu handler** — Chrome collapses it before showing the menu. Read `event.target` and walk parents to find the editable ancestor.
- **Trusting that the content script auto-bootstraps only when userscript globals are set** — it doesn't. In the extension build, `bootstrap()` constructs `createExtensionTransport()` + `createStorage(chromeBackend)` inline. Without that, the inline button never appears and context-menu clicks silently fail.
