import { describe, expect, it } from "bun:test";

import { confirmSubmit } from "./confirm";

describe("confirmSubmit", () => {
  it("quotes dynamic confirmation text as a JavaScript string literal", () => {
    const handler = confirmSubmit("Destroy node bad');globalThis.pwned=1;//?");

    expect(handler).toBe(`return confirm("Destroy node bad');globalThis.pwned=1;//?")`);
    expect(handler).not.toContain("confirm('");
  });
});
