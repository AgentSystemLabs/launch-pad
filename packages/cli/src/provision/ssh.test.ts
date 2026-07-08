import { describe, expect, it } from "vitest";
import { SSH_PREFLIGHT_COMMAND, parseSshHost, sshArgs } from "./ssh";

describe("parseSshHost", () => {
  it("splits user@host", () => {
    expect(parseSshHost("ec2-user@203.0.113.7")).toEqual({
      user: "ec2-user",
      host: "203.0.113.7",
    });
  });

  it("returns host only when there is no user", () => {
    expect(parseSshHost("203.0.113.7")).toEqual({ host: "203.0.113.7" });
  });

  it("splits on the first @ only", () => {
    expect(parseSshHost("root@host@weird")).toEqual({ user: "root", host: "host@weird" });
  });

  it("treats a leading @ as no user", () => {
    expect(parseSshHost("@example.com")).toEqual({ host: "example.com" });
  });
});

describe("sshArgs", () => {
  it("builds non-interactive ssh args with key, port, and remote command", () => {
    expect(
      sshArgs(
        { user: "ubuntu", host: "203.0.113.7", port: 2222, key: "~/.ssh/id_ed25519" },
        SSH_PREFLIGHT_COMMAND,
      ),
    ).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-i",
      "~/.ssh/id_ed25519",
      "-p",
      "2222",
      "--",
      "ubuntu@203.0.113.7",
      "sudo -n true",
    ]);
  });

  it("uses a bare host when no user is provided", () => {
    expect(sshArgs({ host: "example.com" }, "sudo bash -s").slice(-3)).toEqual([
      "--",
      "example.com",
      "sudo bash -s",
    ]);
  });

  it("terminates options before the host to avoid option injection", () => {
    expect(sshArgs({ host: "-oProxyCommand=sh" }, SSH_PREFLIGHT_COMMAND).slice(-3)).toEqual([
      "--",
      "-oProxyCommand=sh",
      "sudo -n true",
    ]);
  });
});
