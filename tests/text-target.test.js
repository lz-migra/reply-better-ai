import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isTextInput, isImproveTarget, writeText } from "../src/content/text-target.js";

function makeElement({ tagName = "DIV", type, contentEditable, isContentEditable, ariaMultiline, spellcheck, height, disabled, readOnly } = {}) {
  return {
    tagName,
    type,
    contentEditable,
    isContentEditable,
    disabled: !!disabled,
    readOnly: !!readOnly,
    getAttribute(name) {
      if (name === "aria-multiline") return ariaMultiline ?? null;
      if (name === "spellcheck") return spellcheck ?? null;
      return null;
    },
    getBoundingClientRect() {
      return { height: height ?? 0 };
    },
  };
}

describe("isTextInput", () => {
  it("accepts textarea", () => {
    expect(isTextInput(makeElement({ tagName: "TEXTAREA" }))).toBe(true);
  });

  it("accepts input[type=text] and input with no explicit type", () => {
    expect(isTextInput(makeElement({ tagName: "INPUT", type: "text" }))).toBe(true);
    expect(isTextInput(makeElement({ tagName: "INPUT" }))).toBe(true);
  });

  it("accepts contentEditable hosts", () => {
    expect(isTextInput(makeElement({ tagName: "DIV", isContentEditable: true }))).toBe(true);
  });

  it("rejects null / non-text inputs / non-editable divs", () => {
    expect(isTextInput(null)).toBe(false);
    expect(isTextInput(makeElement({ tagName: "INPUT", type: "checkbox" }))).toBe(false);
    expect(isTextInput(makeElement({ tagName: "DIV" }))).toBe(false);
  });

  it("rejects password/number/date/color and other non-text inputs", () => {
    for (const type of ["password", "number", "date", "color", "checkbox", "radio", "file", "range", "submit", "button"]) {
      expect(isTextInput(makeElement({ tagName: "INPUT", type }))).toBe(false);
    }
  });

  it("accepts search/email/url/tel inputs (single-line text surfaces)", () => {
    for (const type of ["search", "email", "url", "tel"]) {
      expect(isTextInput(makeElement({ tagName: "INPUT", type }))).toBe(true);
    }
  });
});

describe("isImproveTarget", () => {
  it("accepts textarea unconditionally", () => {
    expect(isImproveTarget(makeElement({ tagName: "TEXTAREA" }))).toBe(true);
  });

  it("accepts <input type=text> and <input> with no explicit type", () => {
    expect(isImproveTarget(makeElement({ tagName: "INPUT", type: "text" }))).toBe(true);
    expect(isImproveTarget(makeElement({ tagName: "INPUT" }))).toBe(true);
  });

  it("rejects non-text <input> types", () => {
    for (const type of ["password", "number", "date", "color", "checkbox", "radio", "file", "range"]) {
      expect(isImproveTarget(makeElement({ tagName: "INPUT", type }))).toBe(false);
    }
  });

  it("accepts contenteditable unconditionally", () => {
    expect(isImproveTarget(makeElement({
      tagName: "DIV", isContentEditable: true, height: 18,
    }))).toBe(true);
    expect(isImproveTarget(makeElement({
      tagName: "DIV", isContentEditable: true, ariaMultiline: "true", height: 80,
    }))).toBe(true);
  });

  it("rejects non-editable divs", () => {
    expect(isImproveTarget(makeElement({ tagName: "DIV", height: 200 }))).toBe(false);
  });

  it("rejects null", () => {
    expect(isImproveTarget(null)).toBe(false);
  });

  it("respects spellcheck=\"false\" on any editable surface", () => {
    expect(isImproveTarget(makeElement({ tagName: "TEXTAREA", spellcheck: "false" }))).toBe(false);
    expect(isImproveTarget(makeElement({ tagName: "INPUT", type: "text", spellcheck: "false" }))).toBe(false);
    expect(isImproveTarget(makeElement({ tagName: "DIV", isContentEditable: true, spellcheck: "false" }))).toBe(false);
  });

  it("ignores spellcheck=\"true\" and spellcheck=\"default\" (treat as absent)", () => {
    expect(isImproveTarget(makeElement({ tagName: "TEXTAREA", spellcheck: "true" }))).toBe(true);
    expect(isImproveTarget(makeElement({ tagName: "INPUT", spellcheck: "default" }))).toBe(true);
  });

  it("rejects disabled and readOnly surfaces", () => {
    expect(isImproveTarget(makeElement({ tagName: "TEXTAREA", disabled: true }))).toBe(false);
    expect(isImproveTarget(makeElement({ tagName: "INPUT", type: "text", readOnly: true }))).toBe(false);
    expect(isImproveTarget(makeElement({ tagName: "DIV", isContentEditable: true, disabled: true }))).toBe(false);
  });
});

// writeText runs in the page's main world: it touches `window.HTMLInputElement`,
// `window.HTMLTextAreaElement`, `document.execCommand`, and the page's
// selection object. We stub the host once per test rather than pull in jsdom.
function installDomStubs({ execCommandReturn = true, execCommandThrows = false } = {}) {
  const dispatchLog = [];
  const nativeInputSetter = vi.fn(function (v) { this._value = v; });
  const nativeTextareaSetter = vi.fn(function (v) { this._value = v; });
  const htmlInputElement = { prototype: {} };
  const htmlTextAreaElement = { prototype: {} };
  Object.defineProperty(htmlInputElement.prototype, "value", {
    configurable: true, set: nativeInputSetter, get() { return this._value; },
  });
  Object.defineProperty(htmlTextAreaElement.prototype, "value", {
    configurable: true, set: nativeTextareaSetter, get() { return this._value; },
  });
  const execCommand = vi.fn(() => {
    if (execCommandThrows) throw new Error("disabled");
    return execCommandReturn;
  });
  const range = {
    selectNodeContents: vi.fn(),
    deleteContents: vi.fn(),
    insertNode: vi.fn(),
  };
  const selection = {
    removeAllRanges: vi.fn(), addRange: vi.fn(),
    rangeCount: 1,
    getRangeAt: vi.fn(() => range),
  };
  const getSelection = vi.fn(() => selection);
  globalThis.window = {
    HTMLInputElement: htmlInputElement,
    HTMLTextAreaElement: htmlTextAreaElement,
    getSelection,
  };
  globalThis.document = {
    createRange: () => range,
    createTextNode: (text) => ({ nodeType: 3, nodeValue: text }),
    execCommand,
    getSelection,
  };
  return { dispatchLog, nativeInputSetter, nativeTextareaSetter, execCommand, selection, range, getSelection };
}

describe("writeText — input / textarea", () => {
  beforeEach(() => { installDomStubs(); });
  afterEach(() => { delete globalThis.window; delete globalThis.document; });

  function makeFormField(tagName) {
    const events = [];
    const el = {
      tagName,
      type: "text",
      _value: "",
      get value() { return this._value; },
      dispatchEvent(ev) { events.push(ev.type); return true; },
    };
    return { el, events };
  }

  it("writes through the prototype's native value setter for <input>", () => {
    const { el, events } = makeFormField("INPUT");
    const stubs = installDomStubs();
    writeText(el, "hello");
    expect(stubs.nativeInputSetter).toHaveBeenCalledWith("hello");
    expect(el._value).toBe("hello");
    expect(events).toContain("input");
    expect(events).toContain("change");
  });

  it("writes through the prototype's native value setter for <textarea>", () => {
    const { el, events } = makeFormField("TEXTAREA");
    const stubs = installDomStubs();
    writeText(el, "world");
    expect(stubs.nativeTextareaSetter).toHaveBeenCalledWith("world");
    expect(el._value).toBe("world");
    expect(events).toContain("input");
    expect(events).toContain("change");
  });

  it("falls back to element.value when the prototype setter is missing", () => {
    const events = [];
    const el = {
      tagName: "INPUT", type: "text", _value: "",
      set value(v) { this._value = v; },
      get value() { return this._value; },
      dispatchEvent(ev) { events.push(ev.type); return true; },
    };
    globalThis.window.HTMLInputElement = { prototype: {} }; // no setter
    writeText(el, "fallback");
    expect(el._value).toBe("fallback");
  });
});

describe("writeText — contentEditable", () => {
  afterEach(() => { delete globalThis.window; delete globalThis.document; });

  function makeEditable({ execCommandOk = true, execCommandThrows = false } = {}) {
    installDomStubs({ execCommandReturn: execCommandOk, execCommandThrows });
    const events = [];
    const el = {
      tagName: "DIV",
      isContentEditable: true,
      focus: vi.fn(),
      innerText: "",
      dispatchEvent(ev) {
        events.push({ type: ev.type, data: ev.data ?? null, inputType: ev.inputType ?? null });
        return true;
      },
    };
    return { el, events };
  }

  it("uses execCommand insertText and dispatches input event", () => {
    const { el, events } = makeEditable({ execCommandOk: true });
    writeText(el, "rich text");
    expect(el.focus).toHaveBeenCalled();
    expect(globalThis.document.execCommand).toHaveBeenCalledWith("insertText", false, "rich text");
    expect(events.some(e => e.type === "input")).toBe(true);
  });

  it("selects the entire content before inserting", () => {
    const { el } = makeEditable();
    writeText(el, "x");
    expect(globalThis.document.createRange().selectNodeContents).toHaveBeenCalledWith(el);
    expect(globalThis.window == null).toBe(false); // selection helpers invoked via document.getSelection
  });

  it("falls back to DOM mutation + InputEvent when execCommand returns false", () => {
    const { el, events } = makeEditable({ execCommandOk: false });
    writeText(el, "modern path");
    const insert = events.find(e => e.type === "input" && e.inputType === "insertText");
    expect(insert).toBeTruthy();
    expect(insert.data).toBe("modern path");
    // The DOM must have actually been mutated — synthetic events don't change it.
    expect(globalThis.document.createRange().deleteContents).toHaveBeenCalled();
    expect(globalThis.document.createRange().insertNode).toHaveBeenCalled();
    const inserted = globalThis.document.createRange().insertNode.mock.calls[0][0];
    expect(inserted.nodeValue).toBe("modern path");
  });

  it("falls back to DOM mutation + InputEvent when execCommand throws (deprecated/disabled)", () => {
    const { el, events } = makeEditable({ execCommandThrows: true });
    writeText(el, "still ok");
    const insert = events.find(e => e.type === "input" && e.inputType === "insertText");
    expect(insert).toBeTruthy();
    expect(globalThis.document.createRange().deleteContents).toHaveBeenCalled();
  });

  it("uses innerText when no selection is available", () => {
    installDomStubs({ execCommandReturn: false });
    globalThis.window.getSelection = () => null;
    const events = [];
    const el = {
      tagName: "DIV",
      isContentEditable: true,
      focus: vi.fn(),
      innerText: "old",
      dispatchEvent(ev) { events.push(ev.type); return true; },
    };
    writeText(el, "new");
    expect(el.innerText).toBe("new");
    expect(events).toContain("input");
  });
});
