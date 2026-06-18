import {
  DeleteParameterCommand,
  GetParametersByPathCommand,
  GetParametersCommand,
  PutParameterCommand,
} from "@aws-sdk/client-ssm";
import { describe, expect, it, vi } from "vitest";
import {
  deleteSecretParameter,
  getExistingSecretPaths,
  listSecretsByPrefix,
  putSecretParameter,
} from "./ssm-secrets";

describe("ssm secret helpers", () => {
  it("stores secret values as SecureString with overwrite enabled", async () => {
    const send = vi.fn().mockResolvedValue({});

    await putSecretParameter({ send } as never, "/launch-pad/default/app/api/DATABASE_URL", "postgres://secret");

    const command = send.mock.calls[0]![0] as PutParameterCommand;
    expect(command).toBeInstanceOf(PutParameterCommand);
    expect(command.input).toMatchObject({
      Name: "/launch-pad/default/app/api/DATABASE_URL",
      Value: "postgres://secret",
      Type: "SecureString",
      Overwrite: true,
    });
  });

  it("checks existence without decrypting secret values", async () => {
    const send = vi.fn().mockResolvedValue({
      Parameters: [{ Name: "/launch-pad/default/app/api/DATABASE_URL", Value: "should-not-matter" }],
    });

    const existing = await getExistingSecretPaths(
      { send } as never,
      ["/launch-pad/default/app/api/DATABASE_URL"],
    );

    const command = send.mock.calls[0]![0] as GetParametersCommand;
    expect(command).toBeInstanceOf(GetParametersCommand);
    expect(command.input.WithDecryption).toBe(false);
    expect(existing).toEqual(new Set(["/launch-pad/default/app/api/DATABASE_URL"]));
  });

  it("batches existence checks by the 10-name GetParameters limit", async () => {
    const paths = Array.from({ length: 23 }, (_, i) => `/launch-pad/default/app/api/KEY_${i}`);
    const send = vi
      .fn()
      // Each call echoes back its own requested names as "found".
      .mockImplementation((cmd: GetParametersCommand) =>
        Promise.resolve({ Parameters: (cmd.input.Names ?? []).map((Name) => ({ Name })) }),
      );

    const existing = await getExistingSecretPaths({ send } as never, paths);

    // 23 names → 10 + 10 + 3 → three calls, none exceeding the limit.
    expect(send).toHaveBeenCalledTimes(3);
    for (const call of send.mock.calls) {
      expect((call[0] as GetParametersCommand).input.Names!.length).toBeLessThanOrEqual(10);
    }
    expect(existing).toEqual(new Set(paths));
  });

  it("returns an empty set without calling SSM when there are no paths", async () => {
    const send = vi.fn();
    const existing = await getExistingSecretPaths({ send } as never, []);
    expect(send).not.toHaveBeenCalled();
    expect(existing).toEqual(new Set());
  });

  it("lists names only and never exposes returned values", async () => {
    const send = vi.fn().mockResolvedValue({
      Parameters: [
        {
          Name: "/launch-pad/default/app/api/DATABASE_URL",
          Value: "postgres://secret",
        },
      ],
    });

    const listed = await listSecretsByPrefix({ send } as never, "/launch-pad/default/app/api");

    const command = send.mock.calls[0]![0] as GetParametersByPathCommand;
    expect(command).toBeInstanceOf(GetParametersByPathCommand);
    expect(command.input.WithDecryption).toBe(false);
    expect(listed).toEqual([
      { name: "DATABASE_URL", path: "/launch-pad/default/app/api/DATABASE_URL" },
    ]);
    expect(JSON.stringify(listed)).not.toContain("postgres://secret");
  });

  it("deletes the exact parameter path", async () => {
    const send = vi.fn().mockResolvedValue({});

    await deleteSecretParameter({ send } as never, "/launch-pad/default/app/api/DATABASE_URL");

    const command = send.mock.calls[0]![0] as DeleteParameterCommand;
    expect(command).toBeInstanceOf(DeleteParameterCommand);
    expect(command.input.Name).toBe("/launch-pad/default/app/api/DATABASE_URL");
  });
});
