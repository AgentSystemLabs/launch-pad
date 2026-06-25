import { describe, expect, it } from "vitest";
import { formatSecretOutput, shellEscapeSecret } from "./format";

describe("shellEscapeSecret", () => {
  it("wraps values in single quotes", () => {
    expect(shellEscapeSecret("postgres://u:p@host/db")).toBe(
      "'postgres://u:p@host/db'",
    );
  });

  it("escapes embedded single quotes", () => {
    expect(shellEscapeSecret("it's")).toBe(`'it'\"'\"'s'`);
  });
});

describe("formatSecretOutput", () => {
  it("returns the raw value", () => {
    expect(formatSecretOutput("DATABASE_URL", "postgres://x", "value")).toBe(
      "postgres://x",
    );
  });

  it("returns a shell export line", () => {
    expect(formatSecretOutput("DATABASE_URL", "postgres://x", "shell")).toBe(
      "export DATABASE_URL='postgres://x'",
    );
  });

  it("returns json with key and value", () => {
    expect(
      JSON.parse(formatSecretOutput("JWT_SECRET", "abc", "json")),
    ).toEqual({ key: "JWT_SECRET", value: "abc" });
  });
});
