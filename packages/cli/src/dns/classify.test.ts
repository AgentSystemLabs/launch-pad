import { describe, expect, it } from "vitest";
import { classifyDns, type DnsObservation, ipv4InCidr, isCloudflareIp, isIpv4 } from "./classify";

const obs = (over: Partial<DnsObservation> = {}): DnsObservation => ({
  a: [],
  aaaa: [],
  cname: null,
  ...over,
});

describe("ipv4InCidr", () => {
  it("matches inside the block and rejects outside", () => {
    expect(ipv4InCidr("104.16.5.5", "104.16.0.0/13")).toBe(true);
    expect(ipv4InCidr("104.23.255.255", "104.16.0.0/13")).toBe(true);
    expect(ipv4InCidr("104.24.0.0", "104.16.0.0/13")).toBe(false);
    expect(ipv4InCidr("8.8.8.8", "104.16.0.0/13")).toBe(false);
  });

  it("handles a /17 boundary correctly", () => {
    // 198.41.128.0/17 covers .128.0–.255.255, NOT .0.0–.127.255
    expect(ipv4InCidr("198.41.200.1", "198.41.128.0/17")).toBe(true);
    expect(ipv4InCidr("198.41.100.1", "198.41.128.0/17")).toBe(false);
  });

  it("returns false for malformed input instead of throwing", () => {
    expect(ipv4InCidr("not-an-ip", "104.16.0.0/13")).toBe(false);
    expect(ipv4InCidr("104.16.5.5", "garbage")).toBe(false);
    expect(ipv4InCidr("999.1.1.1", "104.16.0.0/13")).toBe(false);
  });
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

describe("isCloudflareIp", () => {
  it("recognizes well-known Cloudflare ranges", () => {
    expect(isCloudflareIp("104.16.1.1")).toBe(true);
    expect(isCloudflareIp("172.64.0.1")).toBe(true);
    expect(isCloudflareIp("162.159.0.1")).toBe(true); // 162.158.0.0/15
    expect(isCloudflareIp("131.0.72.5")).toBe(true);
  });

  it("does not flag non-Cloudflare IPs (e.g. an EC2 Elastic IP, Google DNS)", () => {
    expect(isCloudflareIp("54.210.1.2")).toBe(false);
    expect(isCloudflareIp("8.8.8.8")).toBe(false);
    expect(isCloudflareIp("1.1.1.1")).toBe(false); // CF's resolver, NOT in their proxy ranges
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

  it("cloudflare-proxied when A records are Cloudflare IPs (the HTTP-01 footgun)", () => {
    const v = classifyDns(obs({ a: ["104.16.1.1", "104.16.2.2"] }), EIP);
    expect(v.status).toBe("cloudflare-proxied");
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/cloudflare/i);
  });

  it("flags Cloudflare proxy even when the expected IP is unknown", () => {
    const v = classifyDns(obs({ a: ["172.64.1.1"] }), null);
    expect(v.status).toBe("cloudflare-proxied");
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
