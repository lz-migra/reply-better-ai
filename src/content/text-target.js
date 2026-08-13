// Input types we explicitly refuse to treat as "improve" targets. The native
// spellcheck ignores these surfaces too — buttons, password fields, pickers,
// number inputs and friends shouldn't be rewritten by an AI pass.
// `type="text"` and unset `type` are accepted so the user can polish any plain
// text <input>.
const EXCLUDED_INPUT_TYPES = new Set([
  "password", "hidden", "submit", "button", "reset",
  "checkbox", "radio", "file", "image", "range",
  "color", "date", "datetime-local", "month", "time", "week", "number",
]);

// Mirror of the native browser spellcheck gate, expressed in three layers:
//   1. element.disabled / readOnly  — explicit non-interactive state
//   2. spellcheck="false"            — explicit opt-out from the page author
//   3. EXCLUDED_INPUT_TYPES / tag    — non-text surfaces
// Layered this way so each rule is local to one branch and the overall
// precedence is obvious at a glance.
export function isTextInput(element) {
  if (!element || typeof element.tagName !== "string") return false;
  if (element.disabled || element.readOnly) return false;
  if (typeof element.getAttribute === "function" && element.getAttribute("spellcheck") === "false") return false;
  const tag = element.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    const t = (element.type || "text").toLowerCase();
    return !EXCLUDED_INPUT_TYPES.has(t);
  }
  // isContentEditable is the canonical DOM boolean: true when the element is
  // editable directly OR inherits contenteditable from an ancestor (e.g. an
  // iframe's designMode="on" document, or a child <div> inside a contenteditable
  // wrapper). Checking contentEditable === "true" is redundant.
  return element.isContentEditable === true;
}

export function isImproveTarget(element) {
  return isTextInput(element);
}

export function readText(element) {
  if (element.tagName === "TEXTAREA" || element.tagName === "INPUT") return element.value;
  return element.innerText;
}

export function writeText(element, value) {
  if (element.tagName === "TEXTAREA" || element.tagName === "INPUT") {
    // React, Vue, Angular and other virtual-DOM frameworks install their own
    // `value` setter on the element instance to track changes. Assigning
    // `element.value = …` writes through that tracked setter, which means the
    // framework's internal state never updates — the next keystroke or focus
    // event restores the old value from the framework's state. Bypass the
    // instance setter by invoking the prototype's native setter directly; the
    // assignment is then indistinguishable from user input.
    const proto = element.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  if (element.isContentEditable) {
    // Rich-text editors (Gmail, Notion, Twitter/X, LinkedIn) maintain their
    // own DOM and undo stack. Writing innerText directly would wipe internal
    // structure and break Ctrl+Z. execCommand("insertText", …) is deprecated
    // but still the only path that integrates with the browser's native undo
    // buffer — same trick Grammarly and LanguageTool use.
    element.focus();
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    let ok = false;
    try { ok = document.execCommand("insertText", false, value); }
    catch { /* falls through to the InputEvent path */ }
    if (!ok) {
      // Synthesized events notify listeners but don't mutate the DOM by
      // themselves. execCommand failed, so we have to do the mutation by hand
      // and then notify the framework. Prefer the live selection's range so
      // we preserve the cursor position the user just had; fall back to
      // innerText only if there is no selection at all.
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(value));
      } else {
        element.innerText = value;
      }
      let ev;
      try {
        ev = new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: value });
      } catch {
        ev = new Event("input", { bubbles: true, cancelable: true });
        ev.inputType = "insertText";
        ev.data = value;
      }
      element.dispatchEvent(ev);
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }
}
