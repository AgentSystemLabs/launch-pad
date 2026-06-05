import { describe, expect, it } from "vitest";
import { parseNodeNames } from "./index";

describe("parseNodeNames", () => {
  it("parses a single name", () => {
    expect(parseNodeNames("node-a")).toEqual(["node-a"]);
  });

  it("parses comma-separated names with surrounding whitespace", () => {
    expect(parseNodeNames(" node-a , node-b,node-c ")).toEqual(["node-a", "node-b", "node-c"]);
  });

  it("parses multiple positional arguments", () => {
    expect(parseNodeNames(["node-a", "node-b", "node-c"])).toEqual(["node-a", "node-b", "node-c"]);
  });

  it("parses comma-separated values inside positional arguments", () => {
    expect(parseNodeNames(["node-a,node-b", "node-c"])).toEqual(["node-a", "node-b", "node-c"]);
  });

  it("dedupes repeated names while preserving order", () => {
    expect(parseNodeNames("a,b,a,c,b")).toEqual(["a", "b", "c"]);
  });

  it("throws when no names are provided", () => {
    expect(() => parseNodeNames("  ,  ")).toThrow(/no node names provided/);
    expect(() => parseNodeNames([])).toThrow(/no node names provided/);
  });

  it("rejects invalid node names", () => {
    expect(() => parseNodeNames("good-node,bad node")).toThrow(/invalid node name "bad node"/);
    expect(() => parseNodeNames("-starts-with-hyphen")).toThrow(/invalid node name/);
  });
});
