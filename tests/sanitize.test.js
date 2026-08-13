import { describe, it, expect } from "vitest";
import { cleanModelOutput } from "../src/lib/sanitize.js";

describe("cleanModelOutput", () => {
  it("leaves a clean rewrite untouched", () => {
    const t = "Hi Jordan,\n\nThanks for the proposal. Let's talk this week.";
    expect(cleanModelOutput(t)).toBe(t);
  });

  it("strips a 'Here's a … version:' preamble", () => {
    const input = "Here's a friendlier version of your email:\n\nHi there!\n\nWelcome aboard.";
    expect(cleanModelOutput(input)).toBe("Hi there!\n\nWelcome aboard.");
  });

  it("strips surrounding markdown rules", () => {
    const input = "---\nHi there!\n\nWelcome aboard.\n---";
    expect(cleanModelOutput(input)).toBe("Hi there!\n\nWelcome aboard.");
  });

  it("strips a trailing 'Would you like …?' offer", () => {
    const input = "Hi there!\n\nWelcome aboard.\n\nWould you like me to adjust the tone or add branding?";
    expect(cleanModelOutput(input)).toBe("Hi there!\n\nWelcome aboard.");
  });

  it("unwraps a fully fenced code block", () => {
    const input = "```\nHi there!\n```";
    expect(cleanModelOutput(input)).toBe("Hi there!");
  });

  it("handles the combined chatty wrapper from a weak model", () => {
    const input = "Here's a friendly, polished version of your verification email:\n\n---\n\nHi there!\n\nEnter this verification code to continue.\n\n---\n\nWould you like me to adjust the tone further?";
    expect(cleanModelOutput(input)).toBe("Hi there!\n\nEnter this verification code to continue.");
  });

  it("does not strip legitimate content that merely contains a dash line mid-text", () => {
    const input = "Section A\n\n---\n\nSection B";
    // internal rule is preserved; only leading/trailing rules are removed
    expect(cleanModelOutput(input)).toBe(input);
  });

  it("returns non-strings unchanged", () => {
    expect(cleanModelOutput(null)).toBe(null);
    expect(cleanModelOutput(undefined)).toBe(undefined);
  });

  it("strips a leading <think>…</think> block (Qwen3 / DeepSeek-R1 style)", () => {
    const input = "<think>The user wants a friendlier version. Let me rewrite.</think>Hi there!\n\nWelcome aboard.";
    expect(cleanModelOutput(input)).toBe("Hi there!\n\nWelcome aboard.");
  });

  it("strips a multiline <think> block", () => {
    const input = "<think>\nstep 1: parse\nstep 2: rewrite\nstep 3: format\n</think>\n\nHi there!";
    expect(cleanModelOutput(input)).toBe("Hi there!");
  });

  it("strips reasoning blocks wherever they appear (not only as a prefix)", () => {
    const input = "Opening line.\n\n<think>internal notes</think>\n\nClosing line.";
    // The block itself is stripped; trailing whitespace before/after is NOT
    // trimmed by this rule (that's the job of TRAILING_OFFER / rules below).
    expect(cleanModelOutput(input)).toBe("Opening line.\n\n\n\nClosing line.");
  });

  it("strips <|reasoning|>…</|reasoning|> (GPT-OSS / vLLM style)", () => {
    const input = "<|reasoning|>internal notes<|/reasoning|>Hi there!";
    expect(cleanModelOutput(input)).toBe("Hi there!");
  });

  it("strips <reasoning>…</reasoning> (some providers)", () => {
    const input = "<reasoning>internal notes</reasoning>Hi there!";
    expect(cleanModelOutput(input)).toBe("Hi there!");
  });

  it("strips <thought>…</thought> (Kimi / other variants)", () => {
    const input = "<thought>internal notes</thought>Hi there!";
    expect(cleanModelOutput(input)).toBe("Hi there!");
  });

  it("strips multiple reasoning blocks from the same response", () => {
    const input = "<think>first<></think>real answer<think>second<></think>more answer";
    expect(cleanModelOutput(input)).toBe("real answermore answer");
  });

  it("strips an empty <think> block (no content)", () => {
    const input = "<think></think>Hi there!";
    expect(cleanModelOutput(input)).toBe("Hi there!");
  });

  it("does not match an unclosed reasoning tag", () => {
    const input = "Hello <think> world without close";
    expect(cleanModelOutput(input)).toBe(input);
  });
});
