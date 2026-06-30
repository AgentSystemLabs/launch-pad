import { spawn } from "node:child_process";
import { CliError } from "../errors";

export interface SshTarget {
  host: string;
  user?: string;
  port?: number;
  /** Path to a private key (`ssh -i`); omitted uses the agent / default keys. */
  key?: string;
}

export const SSH_PREFLIGHT_COMMAND = "sudo -n true";

/**
 * Split a `user@host` (or bare `host`) string. PURE. Only the FIRST `@` separates the
 * user from the host, so an empty user (`@host`) yields `{ host: "host" }` with no user.
 */
export function parseSshHost(host: string): { user?: string; host: string } {
  const at = host.indexOf("@");
  if (at < 0) return { host };
  const user = host.slice(0, at);
  const rest = host.slice(at + 1);
  return user ? { user, host: rest } : { host: rest };
}

export function sshArgs(target: SshTarget, remoteCommand: string): string[] {
  const userHost = target.user ? `${target.user}@${target.host}` : target.host;
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    ...(target.key ? ["-i", target.key] : []),
    ...(target.port ? ["-p", String(target.port)] : []),
    "--",
    userHost,
    remoteCommand,
  ];
}

/** Run a remote SSH command and return stdout. Stderr is used only for error detail. */
export async function sshCaptureCommand(target: SshTarget, remoteCommand: string): Promise<string> {
  const userHost = target.user ? `${target.user}@${target.host}` : target.host;
  const args = sshArgs(target, remoteCommand);
  return new Promise<string>((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(
        new CliError(`failed to run ssh on ${userHost}: ${error.message}`, {
          hint: "ensure `ssh` is installed and the host is reachable",
        }),
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const detail = stderr.trim() || stdout.trim();
      reject(
        new CliError(`SSH command failed on ${userHost}${detail ? `: ${detail}` : ""}`, {
          hint: "ensure the SSH key/user is correct; pass --ssh-key/--ssh-port if needed",
        }),
      );
    });
  });
}

/** Verify SSH reaches the host and the user has passwordless sudo before creating credentials. */
export async function sshPreflight(target: SshTarget): Promise<void> {
  const userHost = target.user ? `${target.user}@${target.host}` : target.host;
  const args = sshArgs(target, SSH_PREFLIGHT_COMMAND);
  return new Promise<void>((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer | string): void => {
      output += chunk.toString();
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (error) => {
      reject(
        new CliError(`failed to run ssh on ${userHost}: ${error.message}`, {
          hint: "ensure `ssh` is installed and the host is reachable",
        }),
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = output.trim();
      reject(
        new CliError(`SSH preflight failed on ${userHost}${detail ? `: ${detail}` : ""}`, {
          hint: "ensure the SSH key/user is correct and can run passwordless sudo (`sudo -n true`); pass --ssh-key/--ssh-port if needed",
        }),
      );
    });
  });
}

/**
 * Run a bash script on a remote host over SSH, as root (`sudo bash -s`), streaming the
 * script in on stdin so nothing sensitive lands in the process argv / shell history.
 *
 * `BatchMode=yes` fails fast instead of prompting for a password (keys only);
 * `StrictHostKeyChecking=accept-new` trusts a first-seen host but still rejects a
 * changed key. stdout+stderr lines are forwarded to `onLine` as they arrive. Rejects
 * with a {@link CliError} on a spawn error or a non-zero exit.
 */
export async function sshRunScript(
  target: SshTarget,
  script: string,
  onLine?: (line: string) => void,
): Promise<void> {
  const userHost = target.user ? `${target.user}@${target.host}` : target.host;
  const args = sshArgs(target, "sudo bash -s");

  return new Promise<void>((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });

    const emit = (chunk: Buffer | string): void => {
      if (!onLine) return;
      for (const line of chunk.toString().split("\n")) {
        if (line.length > 0) onLine(line);
      }
    };
    child.stdout?.on("data", emit);
    child.stderr?.on("data", emit);

    child.on("error", (error) => {
      reject(
        new CliError(`failed to run ssh on ${userHost}: ${error.message}`, {
          hint: "ensure `ssh` is installed and the host is reachable",
        }),
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new CliError(`ssh bootstrap on ${userHost} exited with code ${code ?? "unknown"}`, {
          hint: "check SSH access (key + sudo) and re-run; pass --ssh-key/--ssh-port if needed",
        }),
      );
    });

    child.stdin?.on("error", () => {
      // The remote may close stdin before we finish writing (e.g. it exits early).
      // The non-zero `close` handler reports the real failure; swallow EPIPE here.
    });
    child.stdin?.end(script);
  });
}
