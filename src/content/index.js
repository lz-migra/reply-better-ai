import browser from "../lib/browser.js";
import { isTextInput, isImproveTarget, isEditableForMenu, readText, writeText } from "./text-target.js";
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
// Chrome clears the page selection before showing the native context menu, so
// by the time our onMessage handler fires, window.getSelection() is empty.
// We capture the right-click target + (optional) selection on `contextmenu`
// and use it when the menu item is clicked. event.target is the most reliable
// signal — sites like Google re-focus in their own contextmenu handler and
// collapse the selection, but the target element is always populated.
let lastContextMenu = null; // { field, selectedText, at }

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
  document.addEventListener("contextmenu", handleContextMenu, true);
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

// Find the editable field that owns the current page selection (if any).
// Returns the closest editable ancestor of the selection's anchor node, or null.
// This is what the context-menu entry needs: the right-click could have fired
// over any element and document.activeElement may not reflect it (e.g. when the
// page took focus via programmatic blur, or the field never received focus
// events that our content script captured). For context menus we care about
// where the selection is, not where the focus is.
function editableFromSelection() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const node = sel.anchorNode;
  if (!node) return null;
  let el = node.nodeType === 3 ? node.parentElement : node;
  while (el && el !== document.body) {
    if (isEditableForMenu(el)) return el;
    el = el.parentElement;
  }
  return null;
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

// Triggered by the right-click context menu ("Help me write or rewrite").
// Primary source is `lastContextMenu` (captured on the contextmenu event,
// before Chrome collapses the selection); fallbacks are the live selection,
// the active field, and finally document.activeElement. If a non-collapsed
// selection was captured inside an editable field, the panel opens in
// "selection" mode and on Insert replaces ONLY that range.
function openFromContextMenu(selectionText) {
  let field = null;
  let capturedSelection = null;
  // Snapshot is fresh only for a short window — beyond a few seconds the
  // snapshot's field may have moved out of the DOM and the user's intent
  // (right-clicking this other field) is no longer represented by it.
  const SNAPSHOT_TTL_MS = 5000;
  if (lastContextMenu && Date.now() - lastContextMenu.at <= SNAPSHOT_TTL_MS) {
    if (lastContextMenu.field.isConnected) {
      field = lastContextMenu.field;
      capturedSelection = lastContextMenu.selectedText;
    }
  }
  if (!field || !isEditableForMenu(field)) {
    field = editableFromSelection();
    if (field) {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) capturedSelection = sel.toString();
    }
  }
  if (!field || !field.isConnected || !isEditableForMenu(field)) field = activeField;
  if (!field || !field.isConnected || !isEditableForMenu(field)) {
    const el = document.activeElement;
    if (isEditableForMenu(el)) field = el;
  }
  if (!field || !field.isConnected) {
    console.warn("[content] openFromContextMenu: no editable field resolved. selection=", (selectionText || capturedSelection || "").length, "chars");
    showToast("Right-click inside a text field, or select the text you want rewritten.", { type: "info" });
    return;
  }
  activeField = field;
  // Re-establish the user's selection inside the field so the panel sees it
  // and so replaceSelection() has the right range to swap.
  const textToRewrite = capturedSelection || selectionText;
  if (textToRewrite && field.tagName !== "INPUT" && field.tagName !== "TEXTAREA") {
    const current = readText(field);
    const idx = current ? current.indexOf(textToRewrite) : -1;
    if (idx >= 0) selectRange(field, idx, idx + textToRewrite.length);
  }
  if (textToRewrite) {
    openPanelForSelection(field, textToRewrite);
    return;
  }
  const mode = detectMode(field);
  ensureButton(onButtonClick);
  setButtonMode(mode);
  setButtonVisible(true);
  positionButton(field);
  openPanelFor(field, mode);
}

// Restore the user's selection by character offset inside a contentEditable
// host. For <input>/<textarea> the caller should use setSelectionRange
// directly so the native caret state is preserved.
function selectRange(field, start, end) {
  if (field.tagName === "INPUT" || field.tagName === "TEXTAREA") {
    try { field.setSelectionRange(start, end); } catch {}
    return;
  }
  const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
  let remaining = start;
  let startNode = null, startOffset = 0, endNode = null, endOffset = 0;
  let node = walker.nextNode();
  while (node) {
    const len = node.nodeValue.length;
    if (!startNode && remaining <= len) { startNode = node; startOffset = remaining; }
    if (remaining + len >= end) { endNode = node; endOffset = end - remaining; break; }
    remaining += len;
    node = walker.nextNode();
  }
  if (!startNode || !endNode) return;
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  sel.removeAllRanges();
  sel.addRange(range);
}

// Same as openPanelFor but for an in-field selection: the panel drafts a
// rewrite for the selected text only, and on Insert replaces the selection
// (not the whole field).
function openPanelForSelection(field, selectedText) {
  const button = getButton();
  if (!button) return;
  ensureButton(onButtonClick);
  setButtonMode("improve");
  setButtonVisible(true);
  positionButton(field);
  openPanel({
    anchorButton: button,
    field,
    mode: "improve",
    draft: selectedText,
    settings,
    onInsert: result => {
      replaceSelection(field, result);
      field.focus();
      showToast("Selection replaced.", {
        type: "success",
        duration: 6000,
        action: { label: "Undo", fn: () => { writeText(field, selectedText); field.focus(); } },
      });
    },
  });
}

// Replace the user's in-field selection with `value`, preserving the
// surrounding text. Falls back to writing the full value if the live
// selection can't be resolved (e.g. the field lost focus between panel
// open and insert click).
function replaceSelection(field, value) {
  if (field.tagName === "TEXTAREA" || field.tagName === "INPUT") {
    const sel = field.selectionStart;
    const selEnd = field.selectionEnd;
    if (sel == null || selEnd == null || sel === selEnd) {
      writeText(field, value);
      return;
    }
    const current = field.value;
    const next = current.slice(0, sel) + value + current.slice(selEnd);
    writeText(field, next);
    const caret = sel + value.length;
    field.setSelectionRange(caret, caret);
    return;
  }
  // contentEditable: writeText already replaces the live selection via execCommand.
  writeText(field, value);
}

// Capture the editable field under the right-click target + (if any) the
// selection text, at the moment of the contextmenu event. Chrome and many
// pages (Google, Facebook) re-focus and collapse the selection in their own
// contextmenu handlers, so by the time our onMessage fires, window.getSelection()
// is empty — but event.target is always populated. The snapshot stores both
// signals: the field (always) and the selection (only if non-empty).
function handleContextMenu(event) {
  let el = event.target;
  if (el && el.nodeType === 3) el = el.parentElement;
  let field = null;
  while (el && el !== document.body) {
    if (isEditableForMenu(el)) { field = el; break; }
    el = el.parentElement;
  }
  if (!field) return;
  const sel = window.getSelection();
  const selectedText = (sel && !sel.isCollapsed && sel.toString().trim())
    ? sel.toString()
    : "";
  lastContextMenu = { field, selectedText, at: Date.now() };
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
