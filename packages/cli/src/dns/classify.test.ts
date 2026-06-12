import { describe, expect, it } from "vitest";
import { classifyDns, type DnsObservation, isIpv4 } from "./classify";

const obs = (over: Partial<DnsObservation> = {}): DnsObservation => ({
  a: [],
  aaaa: [],
  cname: null,
  ...over,
});

describe("isIpv4", () => {
  it("accepts well-formed dotted quads and rejects malformed / out-of-range", () => {
    expect(isIpv4("54.210.10.20")).toBe(true);
    expect(isIpv4("0.0.0.0")).toBe(true);
    expect(isIpv4("255.255.255.255")).toBe(true);
    expect(isIpv4("999.1.1.1")).toBe(false);
    expect(isIpv4("1.2.3")).toBe(false);
    expect(isIpv4("1.2.3.4.5")).toBe(false);
    expect(isIpv4("not-an-ip")).toBe(false);
    expect(isIpv4("2606:4700::1")).toBe(false);
  });
});

describe("classifyDns", () => {
  const EIP = "54.210.10.20";

  it("ok when the only A record is the expected Elastic IP", () => {
    const v = classifyDns(obs({ a: [EIP] }), EIP);
    expect(v.status).toBe("ok");
    expect(v.ok).toBe(true);
  });

  it("wrong-ip when A records don't include the expected IP", () => {
    const v = classifyDns(obs({ a: ["1.2.3.4"] }), EIP);
    expect(v.status).toBe("wrong-ip");
    expect(v.ok).toBe(false);
    expect(v.expectedIp).toBe(EIP);
    expect(v.message).toContain(EIP);
  });

  it("wrong-ip when A records are a proxy/CDN's IPs instead of the Elastic IP", () => {
    const v = classifyDns(obs({ a: ["104.16.1.1", "104.16.2.2"] }), EIP);
    expect(v.status).toBe("wrong-ip");
    expect(v.ok).toBe(false);
    expect(v.message).toContain(EIP);
  });

  it("no-records when nothing resolves (NXDOMAIN / no A record yet)", () => {
    const v = classifyDns(obs({ a: [] }), EIP);
    expect(v.status).toBe("no-records");
    expect(v.ok).toBe(false);
  });

  it("no-expected-ip reports the resolved A records when the target can't be determined", () => {
    const v = classifyDns(obs({ a: ["54.1.2.3"] }), null);
    expect(v.status).toBe("no-expected-ip");
    expect(v.ips).toEqual(["54.1.2.3"]);
    expect(v.ok).toBe(false);
  });

  it("surfaces a CNAME in the message but still classifies by the resolved A records", () => {
    const v = classifyDns(obs({ a: [EIP], cname: "app.herokudns.com" }), EIP);
    expect(v.status).toBe("ok");
    expect(v.cname).toBe("app.herokudns.com");
    expect(v.message).toMatch(/cname/i);
  });

  it("notes an AAAA record (the node serves over IPv4 only)", () => {
    const v = classifyDns(obs({ a: [EIP], aaaa: ["2606:4700::1"] }), EIP);
    expect(v.status).toBe("ok");
    expect(v.aaaa).toEqual(["2606:4700::1"]);
  });
});
