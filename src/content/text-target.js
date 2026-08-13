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
    element.value = value;
  } else {
    element.innerText = value;
  }
  element.dispatchEvent(new Event("input", { bubbles: true }));
}
