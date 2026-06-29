import { HOST_PORT_MAX, HOST_PORT_MIN } from "@agentsystemlabs/launch-pad-shared";
import { describe, expect, it } from "vitest";
import { securityGroupIngressPermissions } from "./ec2";

describe("securityGroupIngressPermissions", () => {
  it("opens SSH only when sshCidr is set", () => {
    const withSsh = securityGroupIngressPermissions({
      role: "edge",
      sshCidr: "203.0.113.10/32",
    });
    const ssh = withSsh.find((p) => p.FromPort === 22);
    expect(ssh?.IpRanges?.[0]?.CidrIp).toBe("203.0.113.10/32");

    const withoutSsh = securityGroupIngressPermissions({ role: "edge" });
    expect(withoutSsh.some((p) => p.FromPort === 22)).toBe(false);
  });

  it("never opens SSH to 0.0.0.0/0", () => {
    const perms = securityGroupIngressPermissions({
      role: "edge",
      sshCidr: "203.0.113.10/32",
    });
    for (const p of perms) {
      for (const r of p.IpRanges ?? []) {
        expect(r.CidrIp).not.toBe("0.0.0.0/0");
      }
    }
  });

  it("scopes app host ports to the edge security group", () => {
    const perms = securityGroupIngressPermissions({
      role: "app",
      edgeSecurityGroupId: "sg-edge",
    });
    expect(perms).toEqual([
      {
        IpProtocol: "tcp",
        FromPort: HOST_PORT_MIN,
        ToPort: HOST_PORT_MAX,
        UserIdGroupPairs: [{ GroupId: "sg-edge", Description: "edge to app host ports" }],
      },
    ]);
  });
});
