import { describe, expect, it } from "vitest";
import { parseSshCidr } from "./ssh-cidr";

describe("parseSshCidr", () => {
  it("accepts a single-host IPv4 CIDR", () => {
    expect(parseSshCidr("203.0.113.10/32")).toBe("203.0.113.10/32");
  });

  it("accepts a subnet CIDR", () => {
    expect(parseSshCidr(" 10.0.0.0/24 ")).toBe("10.0.0.0/24");
  });

  it("rejects world-open IPv4", () => {
    expect(() => parseSshCidr("0.0.0.0/0")).toThrow(/not allowed/);
  });

  it("rejects world-open IPv6", () => {
    expect(() => parseSshCidr("::/0")).toThrow(/not allowed/);
  });

  it("rejects invalid CIDR syntax", () => {
    expect(() => parseSshCidr("not-a-cidr")).toThrow(/invalid --ssh-cidr/);
    expect(() => parseSshCidr("999.999.999.999/32")).toThrow(/invalid --ssh-cidr/);
  });
});
