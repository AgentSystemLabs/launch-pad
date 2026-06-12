import { NODE_ID_REGEX } from "./config";

/**
 * Generated node names: `<noun>-<verb>-<adverb>` (e.g. `dog-runs-fast`). Nodes are
 * cattle — users shouldn't have to invent names for them — so every place the system
 * creates a node without an explicit name draws from this generator: `node create`
 * with no `<name>`, deploy's empty-cluster bootstrap, capacity auto-add, and
 * autoscale scale-out. The one exception is the cluster's single dedicated edge,
 * which keeps the well-known `edge-1` identity.
 *
 * Three 64-word lists give 64³ = 262,144 combinations; collisions against the ids
 * already in the cluster are re-rolled, with a deterministic numeric-suffix fallback
 * so generation can never fail. Every word is lowercase ASCII, so any combination
 * satisfies `NODE_ID_REGEX` (verified by tests).
 */

const NOUNS = [
  "ant", "badger", "bat", "bear", "bee", "bison", "camel", "cat",
  "colt", "crab", "crane", "crow", "deer", "dog", "dove", "duck",
  "eagle", "elk", "falcon", "fawn", "ferret", "finch", "fish", "fox",
  "frog", "gecko", "goat", "goose", "hare", "hawk", "heron", "horse",
  "hound", "husky", "ibis", "koala", "lamb", "lemur", "lion", "llama",
  "lynx", "mole", "moose", "moth", "mouse", "newt", "otter", "owl",
  "panda", "pony", "puma", "quail", "raven", "robin", "seal", "shark",
  "sloth", "snail", "swan", "tiger", "toad", "trout", "whale", "wren",
] as const;

const VERBS = [
  "bounds", "calls", "climbs", "crawls", "darts", "dashes", "digs", "dives",
  "dreams", "drifts", "files", "flies", "floats", "flips", "gazes", "glides",
  "grins", "hides", "hikes", "hops", "howls", "hums", "hunts", "jumps",
  "kicks", "leaps", "lopes", "marches", "naps", "paces", "paints", "plays",
  "prowls", "races", "rests", "rises", "roams", "rolls", "runs", "sails",
  "sings", "skips", "sleeps", "slides", "sneaks", "sniffs", "soars", "spins",
  "sprints", "stands", "strolls", "struts", "surfs", "sways", "swims", "treks",
  "trots", "twirls", "waits", "walks", "wanders", "waves", "yawns", "zooms",
] as const;

const ADVERBS = [
  "ably", "afar", "ahead", "alone", "aloud", "away", "badly", "barely",
  "boldly", "bravely", "briskly", "calmly", "clearly", "coolly", "daily", "dearly",
  "deeply", "deftly", "dimly", "early", "easily", "fast", "fiercely", "fondly",
  "freely", "gently", "gladly", "grandly", "high", "hourly", "keenly", "kindly",
  "late", "lightly", "lively", "loudly", "low", "madly", "neatly", "nicely",
  "nightly", "nimbly", "oddly", "often", "plainly", "proudly", "quickly", "quietly",
  "rarely", "safely", "sharply", "shyly", "simply", "slowly", "softly", "soon",
  "swiftly", "warmly", "weekly", "well", "wildly", "wisely", "yearly", "zestily",
] as const;

/** All three word lists, exported for tests (regex/length/uniqueness invariants). */
export const NODE_NAME_WORDS = { nouns: NOUNS, verbs: VERBS, adverbs: ADVERBS } as const;

/** How many random draws to attempt before falling back to a numeric suffix. */
const MAX_RANDOM_ATTEMPTS = 100;

function pick<T>(list: readonly T[], rng: () => number): T {
  const i = Math.min(list.length - 1, Math.max(0, Math.floor(rng() * list.length)));
  // The clamp guarantees a valid index even for a degenerate rng returning <0 or ≥1.
  return list[i] as T;
}

/**
 * Generate a unique `<noun>-<verb>-<adverb>` node name not present in `usedIds`.
 * Pure given `rng` (defaults to `Math.random`); pass a seeded rng in tests.
 * Re-rolls on collision; after {@link MAX_RANDOM_ATTEMPTS} it appends `-2`, `-3`, …
 * to the last candidate so generation always terminates.
 */
export function generateNodeName(usedIds: Iterable<string> = [], rng: () => number = Math.random): string {
  const used = usedIds instanceof Set ? (usedIds as Set<string>) : new Set(usedIds);
  let candidate = "";
  for (let attempt = 0; attempt < MAX_RANDOM_ATTEMPTS; attempt += 1) {
    candidate = `${pick(NOUNS, rng)}-${pick(VERBS, rng)}-${pick(ADVERBS, rng)}`;
    if (!used.has(candidate)) return candidate;
  }
  for (let n = 2; ; n += 1) {
    const fallback = `${candidate}-${n}`;
    if (!used.has(fallback) && NODE_ID_REGEX.test(fallback)) return fallback;
  }
}

/** Generate `count` distinct node names, none colliding with `usedIds` or each other. */
export function generateNodeNames(
  count: number,
  usedIds: Iterable<string> = [],
  rng: () => number = Math.random,
): string[] {
  const used = new Set(usedIds);
  const names: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const name = generateNodeName(used, rng);
    used.add(name);
    names.push(name);
  }
  return names;
}
