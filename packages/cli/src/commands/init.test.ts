import { describe, expect, it } from "vitest";
import { LABEL_REGEX } from "@agentsystemlabs/launch-pad-shared";
import { toLabel } from "./init";

describe("toLabel", () => {
  it("passes through an already-valid label", () => {
    expect(toLabel("my-app")).toBe("my-app");
  });

  it("lowercases and replaces invalid characters", () => {
    expect(toLabel("My Cool App!")).toBe("my-cool-app");
  });

  it("trims leading/trailing hyphens", () => {
    expect(toLabel("__weird__")).toBe("weird");
  });

  it("falls back to 'app' for empty/unusable input", () => {
    expect(toLabel("!!!")).toBe("app");
    expect(toLabel("")).toBe("app");
  });

  it("always produces a string that satisfies LABEL_REGEX", () => {
    for (const input of ["My Cool App!", "node_express_app", "123", "a".repeat(60)]) {
      expect(LABEL_REGEX.test(toLabel(input))).toBe(true);
    }
  });
});
