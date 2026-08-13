import { MIN_IMPROVE_TARGET_HEIGHT } from "../lib/constants.js";

// Input types we explicitly refuse to treat as "improve" targets. Search boxes
// (`type="search"`) and one-line metadata fields (password, email, url, tel,
// number, date pickers…) are intentionally excluded — they shouldn't be
// "improved" by an AI rewrite. `type="text"` and unset `type` are accepted so
// the user can polish any plain text <input>.
const EXCLUDED_INPUT_TYPES = new Set([
  "search", "password", "email", "url", "tel", "number",
  "date", "datetime-local", "month", "week", "time", "color", "file", "hidden",
  "checkbox", "radio", "submit", "reset", "button", "image", "range",
]);

export function isTextInput(element) {
  if (!element) return false;
  if (element.tagName === "TEXTAREA") return true;
  if (element.tagName === "INPUT") {
    const t = (element.type || "text").toLowerCase();
    return !EXCLUDED_INPUT_TYPES.has(t);
  }
  return element.isContentEditable === true || element.contentEditable === "true";
}

// The button only makes sense on long-form composers, not single-line search
// boxes or username fields. Textareas are always multi-line by intent.
// <input type="text"> is accepted (per user preference) so the rewrite button
// shows up on any plain text input. Contenteditable hosts (Gmail, Twitter/X,
// LinkedIn, Slack) are accepted only when they declare aria-multiline or
// render at least two lines tall.
export function isImproveTarget(element) {
  if (!element) return false;
  if (element.tagName === "TEXTAREA") return true;
  if (element.tagName === "INPUT") {
    const t = (element.type || "text").toLowerCase();
    return !EXCLUDED_INPUT_TYPES.has(t);
  }
  if (element.isContentEditable !== true && element.contentEditable !== "true") return false;
  if (element.getAttribute && element.getAttribute("aria-multiline") === "true") return true;
  const rect = typeof element.getBoundingClientRect === "function" ? element.getBoundingClientRect() : null;
  return !!rect && rect.height >= MIN_IMPROVE_TARGET_HEIGHT;
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
