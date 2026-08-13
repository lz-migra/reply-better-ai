import { describe, it, expect } from "vitest";
import { isTextInput, isImproveTarget } from "../src/content/text-target.js";

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
