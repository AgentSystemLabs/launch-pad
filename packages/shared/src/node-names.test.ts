import { describe, expect, it } from "vitest";
import { NODE_ID_REGEX, nodeIdError } from "./config";
import { generateNodeName, generateNodeNames, NODE_NAME_WORDS } from "./node-names";

/** A deterministic rng cycling through the given values. */
function seqRng(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length] ?? 0;
}

describe("NODE_NAME_WORDS", () => {
  it("every word list is 64 unique lowercase words", () => {
    for (const list of Object.values(NODE_NAME_WORDS)) {
      expect(list.length).toBe(64);
      expect(new Set(list).size).toBe(list.length);
      for (const w of list) expect(w).toMatch(/^[a-z]+$/);
    }
  });

  it("the longest possible combination is a valid node id (≤63 chars)", () => {
    const longest = (l: readonly string[]) => [...l].sort((a, b) => b.length - a.length)[0] ?? "";
    const name = `${longest(NODE_NAME_WORDS.nouns)}-${longest(NODE_NAME_WORDS.verbs)}-${longest(NODE_NAME_WORDS.adverbs)}`;
    expect(name.length).toBeLessThanOrEqual(63);
    expect(nodeIdError(name)).toBeNull();
  });
});

describe("generateNodeName", () => {
  it("produces a <noun>-<verb>-<adverb> name", () => {
    const name = generateNodeName([], seqRng([0]));
    expect(name).toBe(`${NODE_NAME_WORDS.nouns[0]}-${NODE_NAME_WORDS.verbs[0]}-${NODE_NAME_WORDS.adverbs[0]}`);
  });

  it("always satisfies the node id rules", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateNodeName()).toMatch(NODE_ID_REGEX);
    }
  });

  it("re-rolls when the candidate collides with an existing id", () => {
    const first = generateNodeName([], seqRng([0]));
    // rng yields the colliding combo first, then a different one.
    const name = generateNodeName([first], seqRng([0, 0, 0, 0.5, 0.5, 0.5]));
    expect(name).not.toBe(first);
    expect(name).toMatch(NODE_ID_REGEX);
  });

  it("falls back to a numeric suffix when every roll collides", () => {
    const stuck = generateNodeName([], seqRng([0]));
    const name = generateNodeName([stuck], seqRng([0]));
    expect(name).toBe(`${stuck}-2`);
  });

  it("tolerates a degenerate rng outside [0, 1)", () => {
    expect(generateNodeName([], () => 1)).toMatch(NODE_ID_REGEX);
    expect(generateNodeName([], () => -1)).toMatch(NODE_ID_REGEX);
  });
});

describe("generateNodeNames", () => {
  it("returns count distinct names avoiding usedIds", () => {
    const used = ["dog-runs-fast"];
    const names = generateNodeNames(5, used);
    expect(names.length).toBe(5);
    expect(new Set([...names, ...used]).size).toBe(6);
    for (const n of names) expect(n).toMatch(NODE_ID_REGEX);
  });
});
