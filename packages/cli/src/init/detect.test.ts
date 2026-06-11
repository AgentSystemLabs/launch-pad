import { describe, expect, it } from "vitest";
import { detectExposePort, detectFramework, projectHints } from "./detect";

describe("detectExposePort", () => {
  it("reads the first EXPOSE port, ignoring a /tcp suffix and other lines", () => {
    const df = `FROM node:24-alpine\nWORKDIR /app\nCOPY . .\nEXPOSE 8080/tcp\nCMD ["node","server.js"]`;
    expect(detectExposePort(df)).toBe(8080);
  });

  it("returns undefined when there is no EXPOSE", () => {
    expect(detectExposePort("FROM alpine\nCMD sh")).toBeUndefined();
  });

  it("rejects an out-of-range port", () => {
    expect(detectExposePort("EXPOSE 99999")).toBeUndefined();
  });

  it("takes the first of multiple EXPOSE lines", () => {
    expect(detectExposePort("EXPOSE 3000\nEXPOSE 9229")).toBe(3000);
  });
});

describe("detectFramework", () => {
  it("detects Express from dependencies", () => {
    expect(detectFramework(JSON.stringify({ dependencies: { express: "^4" } }))).toEqual({
      name: "Express",
      port: 3000,
    });
  });

  it("prefers a meta-framework over a bundled server lib", () => {
    // a Next.js app may also list express somewhere — Next should win (it's listed first)
    const pkg = JSON.stringify({ dependencies: { next: "^14", express: "^4" } });
    expect(detectFramework(pkg)?.name).toBe("Next.js");
  });

  it("checks devDependencies too and returns undefined for a non-web package", () => {
    expect(detectFramework(JSON.stringify({ devDependencies: { astro: "^4" } }))).toEqual({ name: "Astro", port: 4321 });
    expect(detectFramework(JSON.stringify({ dependencies: { lodash: "^4" } }))).toBeUndefined();
  });

  it("returns undefined for malformed JSON", () => {
    expect(detectFramework("{not json")).toBeUndefined();
  });
});

describe("projectHints", () => {
  it("prefers the Dockerfile EXPOSE port over the framework default", () => {
    const hints = projectHints({
      dockerfile: "EXPOSE 8080",
      packageJson: JSON.stringify({ dependencies: { express: "^4" } }),
    });
    expect(hints.port).toBe(8080);
    expect(hints.framework).toBe("Express");
    expect(hints.likelyWeb).toBe(true);
  });

  it("falls back to the framework port when there's no EXPOSE", () => {
    const hints = projectHints({ packageJson: JSON.stringify({ dependencies: { astro: "^4" } }) });
    expect(hints.port).toBe(4321);
    expect(hints.likelyWeb).toBe(true);
  });

  it("reports not-web when neither signal is present", () => {
    expect(projectHints({ dockerfile: "FROM alpine\nCMD sh" })).toEqual({
      port: undefined,
      framework: undefined,
      likelyWeb: false,
    });
  });
});
