/**
 * Initial greetings ("hi", "@devbot hello") are answered in chat.
 * They are not work requests: no request row, no agent launch.
 * The reply is fixed and generic so it never echoes user text or
 * names internal systems.
 */

const INVISIBLE = /[\u200b\u200c\u200d\ufeff]/g;
/** Leading @devbot plus decoration that is not itself a greeting word. */
const LEADING_MENTION = /^@devbot\b[\s.,!?]*/i;

/**
 * Standalone phrases that count as a greeting. Matching is exact after
 * normalization, so "high priority bug" and "hello team" stay out.
 */
const GREETINGS = new Set([
  "hi",
  "hello",
  "hey",
  "hiya",
  "howdy",
  "yo",
  "hola",
  "heya",
  "greetings",
  "hi there",
  "hello there",
  "hey there",
  "good morning",
  "good afternoon",
  "good evening",
  "good night",
  "good day",
  "whats up",
  "sup",
  "hi devbot",
  "hello devbot",
  "hey devbot",
]);

/** Capabilities offered on a greeting. Four plain actions, no follow-up question. */
export const GREETING_OPTIONS = [
  "Create a task card for a feature or a bug",
  "Start a code change and open a pull request",
  "Check the status of work already underway",
  "Give help on a topic",
] as const;

/**
 * Warm welcome plus a compact list of actions.
 * No question marks and no names of internal systems.
 */
export function greetingReply(): string {
  const lines = GREETING_OPTIONS.map((option, index) => `${index + 1}. ${option}`);
  return ["Hi, welcome. Happy to help.", "", ...lines].join("\n");
}

/**
 * True when the message is only a greeting, with or without a leading @devbot.
 * Case, surrounding space, zero-width characters, and trailing punctuation
 * are ignored. Extra task words ("hi, fix the login") are not a greeting.
 */
export function isInitialGreeting(text: string): boolean {
  const cleaned = text.replace(INVISIBLE, "").replace(/\u00a0/g, " ").trim();
  if (!cleaned) return false;

  let rest = cleaned;
  while (LEADING_MENTION.test(rest)) {
    rest = rest.replace(LEADING_MENTION, "").trim();
  }

  return isGreetingPhrase(normalizePhrase(rest));
}

function normalizePhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isGreetingPhrase(phrase: string): boolean {
  if (!phrase) return false;
  if (GREETINGS.has(phrase)) return true;
  // Casual stretches of the same greeting, still not a real word ("high", "hit").
  if (/^h+i+$/.test(phrase)) return true;
  if (/^hey+$/.test(phrase)) return true;
  return false;
}
