import { describe, expect, it } from "vitest";
import { parseDotenv, partitionSecretImportEntries } from "./dotenv";

describe("parseDotenv", () => {
  it("parses simple KEY=VALUE pairs", () => {
    const { entries, malformed } = parseDotenv("DATABASE_URL=postgres://x\nPORT=3000\n");
    expect(malformed).toEqual([]);
    expect(entries).toEqual([
      { key: "DATABASE_URL", value: "postgres://x", line: 1 },
      { key: "PORT", value: "3000", line: 2 },
    ]);
  });

  it("ignores blank lines and full-line comments", () => {
    const { entries } = parseDotenv("# a comment\n\n  # indented comment\nA=1\n");
    expect(entries).toEqual([{ key: "A", value: "1", line: 4 }]);
  });

  it("strips an `export ` prefix and trims around the key", () => {
    const { entries } = parseDotenv("export FOO=bar\n  BAZ = qux\n");
    expect(entries).toEqual([
      { key: "FOO", value: "bar", line: 1 },
      { key: "BAZ", value: "qux", line: 2 },
    ]);
  });

  it("keeps `#` inside an unquoted value (no inline-comment stripping)", () => {
    const { entries } = parseDotenv("PASSWORD=p@ss#word\nURL=https://x/y#frag\n");
    expect(entries.map((e) => e.value)).toEqual(["p@ss#word", "https://x/y#frag"]);
  });

  it("preserves `=` characters in the value", () => {
    const { entries } = parseDotenv("TOKEN=a=b=c\n");
    expect(entries[0]!.value).toBe("a=b=c");
  });

  it("strips matching double quotes and expands escapes", () => {
    const { entries } = parseDotenv('MSG="line1\\nline2\\ttab"\n');
    expect(entries[0]!.value).toBe("line1\nline2\ttab");
  });

  it("treats single quotes as literal (no escape expansion)", () => {
    const { entries } = parseDotenv("RAW='a\\nb'\n");
    expect(entries[0]!.value).toBe("a\\nb");
  });

  it("preserves leading/trailing spaces only inside quotes", () => {
    const { entries } = parseDotenv('SPACED="  padded  "\nBARE=  trimmed  \n');
    expect(entries[0]!.value).toBe("  padded  ");
    expect(entries[1]!.value).toBe("trimmed");
  });

  it("supports multi-line quoted values (e.g. a private key)", () => {
    const file = ['KEY="-----BEGIN-----', "line2", 'line3-----END-----"', "NEXT=ok"].join("\n");
    const { entries } = parseDotenv(file);
    expect(entries[0]).toEqual({
      key: "KEY",
      value: "-----BEGIN-----\nline2\nline3-----END-----",
      line: 1,
    });
    // parsing resumes after the closing-quote line
    expect(entries[1]).toEqual({ key: "NEXT", value: "ok", line: 4 });
  });

  it("flags an unterminated quote as malformed instead of swallowing the rest of the file", () => {
    const { entries, malformed } = parseDotenv('OK=1\nBROKEN="oops\nLATER=2\n');
    // BROKEN never closes its quote — its line is flagged, and LATER is NOT
    // silently absorbed into BROKEN's value.
    expect(entries).toEqual([{ key: "OK", value: "1", line: 1 }]);
    expect(malformed).toEqual([2]);
  });

  it("flags non-blank lines that aren't assignments as malformed", () => {
    const { entries, malformed } = parseDotenv("GOOD=1\nthis is junk\n=novalue\n");
    expect(entries).toEqual([{ key: "GOOD", value: "1", line: 1 }]);
    expect(malformed).toEqual([2, 3]);
  });
});

describe("partitionSecretImportEntries", () => {
  it("accepts valid UPPER_SNAKE keys with non-empty values", () => {
    const plan = partitionSecretImportEntries(parseDotenv("DATABASE_URL=x\nAPI_KEY=y\n"));
    expect(plan.valid).toEqual([
      { key: "DATABASE_URL", value: "x" },
      { key: "API_KEY", value: "y" },
    ]);
    expect(plan.invalidKeys).toEqual([]);
    expect(plan.emptyValues).toEqual([]);
  });

  it("classifies non-conforming keys without dropping the line number", () => {
    const plan = partitionSecretImportEntries(parseDotenv("lower=1\n9NUM=2\nWITH-DASH=3\n"));
    expect(plan.valid).toEqual([]);
    expect(plan.invalidKeys).toEqual([
      { key: "lower", line: 1 },
      { key: "9NUM", line: 2 },
      { key: "WITH-DASH", line: 3 },
    ]);
  });

  it("classifies empty values separately (SSM can't store them)", () => {
    const plan = partitionSecretImportEntries(parseDotenv("OK=1\nEMPTY=\n"));
    expect(plan.valid).toEqual([{ key: "OK", value: "1" }]);
    expect(plan.emptyValues).toEqual([{ key: "EMPTY", line: 2 }]);
  });

  it("dedupes repeated keys (last value wins) and reports the duplicate", () => {
    const plan = partitionSecretImportEntries(parseDotenv("K=first\nK=second\n"));
    expect(plan.valid).toEqual([{ key: "K", value: "second" }]);
    expect(plan.duplicates).toEqual(["K"]);
  });

  it("forwards malformed line numbers from the parser", () => {
    const plan = partitionSecretImportEntries(parseDotenv("A=1\njunk\n"));
    expect(plan.malformed).toEqual([2]);
  });
});
