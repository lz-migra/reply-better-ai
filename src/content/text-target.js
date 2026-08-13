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

// Same shape as a native browser spellcheck: any text-accepting surface shows
// the button. contentEditable hosts are accepted unconditionally because an
// empty rich-text editor (Gmail, Twitter/X, Notion, LinkedIn, Slack) renders
// under the previous 40px threshold, and rejecting them made the button feel
// flaky. EXCLUDED_INPUT_TYPES and spellcheck="false" are the only gates —
// the latter matches the HTML standard's rule that explicit opt-out disables
// spell-check on that field (and on it, AI rewriting is also unwanted).
export function isImproveTarget(element) {
  if (!element) return false;
  const isEditable =
    element.tagName === "TEXTAREA"
    || element.tagName === "INPUT"
      ? !EXCLUDED_INPUT_TYPES.has((element.type || "text").toLowerCase())
      : (element.isContentEditable === true || element.contentEditable === "true");
  if (!isEditable) return false;
  if (typeof element.getAttribute === "function" && element.getAttribute("spellcheck") === "false") return false;
  return true;
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
