import { describe, expect, it } from "vitest";
import { renderSystemdUnit } from "./systemd-unit";

describe("renderSystemdUnit", () => {
  it("app unit orders docker.service", () => {
    const unit = renderSystemdUnit("app");
    expect(unit).toContain("After=docker.service network-online.target");
    expect(unit).toContain("Wants=docker.service network-online.target");
    expect(unit).toContain("ExecStart=/opt/launch-pad/agent");
  });

  it("edge unit does not order docker.service", () => {
    const unit = renderSystemdUnit("edge");
    expect(unit).toContain("After=network-online.target");
    expect(unit).not.toContain("docker.service");
  });

  it("default output has no EnvironmentFile line (EC2/golden-AMI parity)", () => {
    expect(renderSystemdUnit("app")).not.toContain("EnvironmentFile=");
    expect(renderSystemdUnit("edge")).not.toContain("EnvironmentFile=");
  });

  it("injects a single EnvironmentFile line inside [Service] when provided", () => {
    const unit = renderSystemdUnit("app", { environmentFile: "/etc/launch-pad/agent.env" });
    expect(unit).toContain("EnvironmentFile=/etc/launch-pad/agent.env");
    // Exactly one EnvironmentFile line.
    expect(unit.match(/EnvironmentFile=/g)?.length).toBe(1);
    // It sits in [Service], immediately before ExecStart.
    expect(unit).toContain("EnvironmentFile=/etc/launch-pad/agent.env\nExecStart=/opt/launch-pad/agent");
    const serviceIdx = unit.indexOf("[Service]");
    const installIdx = unit.indexOf("[Install]");
    const envIdx = unit.indexOf("EnvironmentFile=");
    expect(envIdx).toBeGreaterThan(serviceIdx);
    expect(envIdx).toBeLessThan(installIdx);
  });

  it("with environmentFile on edge still omits docker ordering", () => {
    const unit = renderSystemdUnit("edge", { environmentFile: "/etc/launch-pad/agent.env" });
    expect(unit).not.toContain("docker.service");
    expect(unit).toContain("EnvironmentFile=/etc/launch-pad/agent.env");
  });
});
