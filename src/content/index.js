import browser from "../lib/browser.js";
import { isTextInput, isImproveTarget, readText, writeText } from "./text-target.js";
import {
  injectStyles, ensureButton, getButton, setButtonMode, setButtonVisible,
  setButtonLoading, positionButton, removeButton, showToast,
} from "./button-injector.js";
import { tryExpandSnippet } from "./snippet-expander.js";
import { openPanel, isPanelOpen, closePanel } from "./panel.js";
import { DEFAULT_STYLE, DEFAULT_CLICK_MODE, DEFAULT_MODEL } from "../lib/constants.js";
import { chromeBackend, createStorage } from "../lib/storage.js";
import { createExtensionTransport } from "../lib/transport.js";

const DEFAULT_SETTINGS = Object.freeze({
  enableInlineButton: true,
  messageType: DEFAULT_STYLE,
  inlineClickMode: DEFAULT_CLICK_MODE,
  model: DEFAULT_MODEL,
  replyConsent: false,
  savedPrompts: [],
  snippets: [],
});
const settings = { ...DEFAULT_SETTINGS };

let activeField = null;
let transport = null;
let storage = null;

export async function bootstrap({ transport: t, storage: s }) {
  transport = t;
  storage = s;
  console.log("[content] bootstrap on", location.hostname);
  await loadSettings();
  injectStyles();
  document.addEventListener("focus", handleFocus, true);
  document.addEventListener("blur", handleBlur, true);
  document.addEventListener("input", handleInput, true);
  document.addEventListener("selectionchange", handleSelectionChange);
  window.addEventListener("scroll", handleReposition, true);
  window.addEventListener("resize", handleReposition);

  const unsub = storage.onChanged((changes) => {
    let touched = false;
    for (const key of Object.keys(changes)) {
      if (!(key in DEFAULT_SETTINGS)) continue;
      const newValue = changes[key].newValue;
      settings[key] = newValue !== undefined ? newValue : DEFAULT_SETTINGS[key];
      touched = true;
    }
    if (touched && !isPanelOpen()) {
      if (!settings.enableInlineButton) { closePanel(); removeButton(); activeField = null; }
      else if (activeField) showButtonFor(activeField);
    }
  });
  // Touch the unsub so it doesn't get GC'd before the page unloads.
  window.addEventListener("pagehide", () => unsub(), { once: true });

  // Context-menu trigger from the service worker. We resolve the target field
  // here (the worker can't see DOM) and open the existing panel — same flow as
  // clicking the inline button. sendResponse keeps the message channel open
  // across the async open so the SW can detect failure on tabs that never
  // injected our content script (chrome://, the web store, before load).
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") {
      sendResponse({ ok: false, error: "Invalid message" });
      return false;
    }
    if (message.action === "openFromContextMenu") {
      console.log("[content] openFromContextMenu received, selection length:", (message.selectionText || "").length);
      try {
        openFromContextMenu(message.selectionText || "");
        sendResponse({ ok: true });
      } catch (e) {
        console.warn("[content] openFromContextMenu failed:", e?.message);
        sendResponse({ ok: false, error: e?.message || "Unknown error" });
      }
      return false;
    }
    return false;
  });
}

async function loadSettings() {
  try {
    const stored = await storage.get([
      "enableInlineButton", "messageType", "inlineClickMode",
      "model", "replyConsent", "savedPrompts", "snippets",
    ]);
    if (stored.enableInlineButton !== undefined) settings.enableInlineButton = stored.enableInlineButton;
    if (stored.messageType) settings.messageType = stored.messageType;
    if (stored.inlineClickMode) settings.inlineClickMode = stored.inlineClickMode;
    if (stored.model) settings.model = stored.model;
    if (stored.replyConsent !== undefined) settings.replyConsent = stored.replyConsent;
    if (Array.isArray(stored.savedPrompts)) settings.savedPrompts = stored.savedPrompts;
    if (Array.isArray(stored.snippets)) settings.snippets = stored.snippets;
  } catch (e) {
    console.warn("[content] settings load failed; disabling inline UI:", e?.message);
    settings.enableInlineButton = false;
  }
}

// Reply when the user has selected text elsewhere on the page; improve when
// they've typed a draft in the field; reply (the friendly default) when empty.
function hasReplySelection(field) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return false;
  if (!sel.toString().trim()) return false;
  if (field && sel.anchorNode && field.contains(sel.anchorNode) && field.contains(sel.focusNode)) return false;
  return true;
}

function detectMode(field) {
  if (hasReplySelection(field)) return "reply";
  if (field && readText(field).trim()) return "improve";
  return "reply";
}

function onButtonClick() {
  if (!activeField) return;
  const mode = detectMode(activeField);
  setButtonMode(mode);
  if (mode === "improve" && settings.inlineClickMode === "instant") {
    improveInstant(activeField);
    return;
  }
  openPanelFor(activeField, mode);
}

function openPanelFor(field, mode) {
  const button = getButton();
  if (!button) return;
  const previous = readText(field);
  openPanel({
    anchorButton: button,
    field,
    mode,
    draft: previous,
    settings,
    onInsert: result => {
      writeText(field, result);
      field.focus();
      showToast(mode === "improve" ? "Your message was polished." : "Reply inserted.", {
        type: "success",
        duration: 6000,
        action: { label: "Undo", fn: () => { writeText(field, previous); field.focus(); } },
      });
    },
  });
}

// Triggered by the right-click context menu ("Help me write or rewrite"). We
// bypass the inline button entirely so the user can invoke the panel from
// chrome's own menu even when they never focused a field — same flow as a
// click on the inline button once a field is resolved. `selectionText` is
// informational; the existing detectMode() reads the live page selection, which
// is what the panel actually uses for reply context.
function openFromContextMenu(selectionText) {
  let field = activeField;
  if (!field || !field.isConnected || !isTextInput(field)) {
    const el = document.activeElement;
    if (isTextInput(el)) field = el;
  }
  if (!field || !field.isConnected) {
    showToast("Click into a text field first, then try again.", { type: "info" });
    return;
  }
  activeField = field;
  const mode = detectMode(field);
  ensureButton(onButtonClick);
  setButtonMode(mode);
  setButtonVisible(true);
  positionButton(field);
  openPanelFor(field, mode);
}

async function improveInstant(field) {
  const text = readText(field);
  if (!text.trim()) return;
  const previous = text;
  field.focus();
  setButtonLoading(true);
  try {
    const response = await transport.stream({
      payload: { action: "improveText", text, messageType: settings.messageType },
    }, 60000);
    if (response?.improvedText) {
      writeText(field, response.improvedText);
      field.focus();
      showToast("Text improved.", {
        type: "success",
        duration: 6000,
        action: { label: "Undo", fn: () => { writeText(field, previous); field.focus(); } },
      });
    } else if (response?.error) {
      showToast(response.error, { type: "error" });
    } else {
      showToast("Empty response from the model. Try again.", { type: "error" });
    }
  } catch (err) {
    console.error("[content] improve failed:", err);
    let msg = err.message || "Unexpected error.";
    if (err.message === "EXT_CONTEXT_INVALIDATED" || msg.includes("Receiving end does not exist")) {
      msg = "The extension was reloaded. Refresh this page and try again.";
    } else if (msg.includes("timed out")) {
      msg = "Request timed out. The model is busy — try again in a moment.";
    }
    showToast(msg, { type: "error" });
  } finally {
    setButtonLoading(false);
  }
}

// Show + position the morph button for a field, reflecting the current mode.
function showButtonFor(field) {
  if (!settings.enableInlineButton || !isImproveTarget(field)) return;
  ensureButton(onButtonClick);
  setButtonMode(detectMode(field));
  setButtonVisible(true);
  positionButton(field);
}

function hideButton() {
  setButtonVisible(false);
}

function refreshButton() {
  if (!activeField) return;
  setButtonMode(detectMode(activeField));
  positionButton(activeField);
}

function handleFocus(event) {
  const target = event.target;
  if (!isTextInput(target)) {
    // Don't immediately hide: blurring a textarea often lands on a non-text
    // element (e.g. a panel button) and the button would flicker. Delay hide.
    setTimeout(() => {
      if (document.activeElement && isTextInput(document.activeElement)) return;
      if (isPanelOpen()) return;
      hideButton();
      if (activeField === target) activeField = null;
    }, 200);
    return;
  }
  activeField = target;
  showButtonFor(target);
}

function handleBlur(event) {
  // Already handled by handleFocus's setTimeout for non-text targets; for text
  // targets wait a beat in case focus is moving to our own panel button.
  const target = event.target;
  setTimeout(() => {
    if (activeField === target && document.activeElement !== target && !isPanelOpen()) {
      hideButton();
      if (activeField === target) activeField = null;
    }
  }, 200);
}

function handleInput(event) {
  const element = event.target;
  if (!isTextInput(element)) return;
  if (settings.enableInlineButton && activeField === element) refreshButton();
  if (settings.snippets.length > 0) tryExpandSnippet(element, settings.snippets);
}

function handleSelectionChange() {
  if (!activeField || !getButton() || isPanelOpen()) return;
  setButtonMode(detectMode(activeField));
}

function handleReposition() {
  if (!activeField || !getButton()) return;
  positionButton(activeField);
}

// Auto-bootstrap: in the extension build, build the transport/storage adapters
// ourselves; in a userscript, the host runtime sets __RB_TRANSPORT__ and
// __RB_STORAGE__ before loading us. The legacy default-bootstrap path below
// guards against double-init so the panel/button listeners aren't attached twice
// when both paths are present (e.g. during development).

const USERSCRIPT_TRANSPORT = typeof globalThis.__RB_TRANSPORT__ !== "undefined" ? globalThis.__RB_TRANSPORT__ : null;
const USERSCRIPT_STORAGE = typeof globalThis.__RB_STORAGE__ !== "undefined" ? globalThis.__RB_STORAGE__ : null;

if (typeof window !== "undefined" && !window.__RB_BOOTSTRAPPED__) {
  window.__RB_BOOTSTRAPPED__ = true;
  if (USERSCRIPT_TRANSPORT && USERSCRIPT_STORAGE) {
    bootstrap({ transport: USERSCRIPT_TRANSPORT, storage: USERSCRIPT_STORAGE });
  } else {
    bootstrap({ transport: createExtensionTransport(), storage: createStorage(chromeBackend) });
  }
}
