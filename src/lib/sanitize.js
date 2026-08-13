// Weaker models sometimes ignore the "output only the rewrite" instruction and
// wrap the result in chatty boilerplate. cleanModelOutput strips the few
// unambiguous wrappers — a "Here's a … version:" preamble, surrounding markdown
// rules/fences, and a trailing "Would you like …?" offer — without touching the
// real content. Conservative by design: when in doubt, leave the text alone.
//
// Reasoning-capable models (Qwen3, DeepSeek-R1, GPT-OSS, Kimi-K2, etc.) emit
// their chain-of-thought as a tagged block BEFORE the user-visible reply using
// one of a few common tags — <think>…</think> (de-facto standard), the Harmony
// special tokens `<|reasoning|>` / `<|/reasoning|>`, and a couple of
// provider-specific tags (`<reasoning>`, `<thought>`). We strip every variant
// up front so the reasoning never reaches the composer; the rewrite itself is
// preserved.

// Plain tags: opening <tag>, closing </tag>. Back-reference \1 binds them so
// `</reasoning>` (a substring of `</|reasoning|>`) can't close a `<reasoning>`
// block early, and lazy quantifier can't span across multiple blocks.
const PLAIN_TAGS = ["think", "reasoning", "thought"];
const PLAIN_RE = new RegExp(`<(${PLAIN_TAGS.join("|")})>[\\s\\S]*?<\\/\\1>`, "gi");

// Harmony / special-token tags: opening <|tag|>, closing `</|tag|>` (standard
// XML order) OR `<|/tag|>` (Harmony, slash inside the angle bracket). Built as
// a literal regex (slashes inside escaped) to avoid template-string maze.
const HARMONY_RE = /<\|(reasoning)\|>[\s\S]*?(?:<\/\|\1\|>|<\|\/\1\|>)/gi;

const REASONING_RES = [PLAIN_RE, HARMONY_RE];

const PREAMBLE = /^(sure|certainly|of course|here(?:'|’|)s|here is|here are)\b[^\n]*:\s*\n+/i;
const TRAILING_OFFER = /\n+\s*(would you like|let me know if|feel free to|hope (?:this|that) helps|happy to)\b[^\n]*$/i;

export function cleanModelOutput(text) {
  if (typeof text !== "string") return text;
  let out = text.trim();

  // Drop reasoning blocks (Qwen3/DeepSeek-R1 etc.) before anything else —
  // they're usually a leading prefix and contain no user-visible content.
  for (const re of REASONING_RES) out = out.replace(re, "");

  // Whole response fenced in a code block → unwrap.
  const fence = out.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  if (fence) out = fence[1].trim();

  out = out.replace(PREAMBLE, "");
  // Trailing "Would you like…?" offer first, so a markdown rule that sat just
  // above it becomes the new trailing rule and gets stripped below.
  out = out.replace(TRAILING_OFFER, "");

  // Leading / trailing markdown horizontal rules ("---" on their own line).
  out = out.replace(/^(?:---+|\*\*\*+|___+)\s*\n+/, "");
  out = out.replace(/\n+\s*(?:---+|\*\*\*+|___+)\s*$/, "");

  return out.trim();
}
