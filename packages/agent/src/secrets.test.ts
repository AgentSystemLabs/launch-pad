import { describe, expect, it, vi } from "vitest";
import { GetParametersCommand } from "@aws-sdk/client-ssm";
import { type ServiceConfig } from "@agentsystemlabs/launch-pad-shared";
import { configureSecretsRegion, resolveServiceEnv, setSsmClientForTest } from "./secrets";

const baseConfig: ServiceConfig = {
  project: "my-app",
  service: "api",
  image: "img:1",
  cpu: 512,
  memory: 512,
  replicas: 1,
  env: { NODE_ENV: "production" },
  secretRefs: [{ name: "DATABASE_URL", ssm: "/launch-pad/default/my-app/api/DATABASE_URL" }],
  ingress: null,
  healthCheck: null,
  rollout: { maxSurge: 1, drainTimeout: "20s", stopGrace: "30s" },
};

describe("resolveServiceEnv", () => {
  it("accepts the configured region before resolving secrets", async () => {
    configureSecretsRegion("us-east-1");
    const send = vi.fn().mockResolvedValue({
      Parameters: [{ Name: "/launch-pad/default/my-app/api/DATABASE_URL", Value: "postgres://x" }],
    });
    setSsmClientForTest({ send } as never);

    await expect(resolveServiceEnv(baseConfig)).resolves.toMatchObject({
      DATABASE_URL: "postgres://x",
    });
    setSsmClientForTest(null);
  });

  it("merges SSM secrets with plain env (env wins on collision)", async () => {
    const send = vi.fn().mockResolvedValue({
      Parameters: [{ Name: "/launch-pad/default/my-app/api/DATABASE_URL", Value: "postgres://x" }],
    });
    setSsmClientForTest({ send } as never);

    const env = await resolveServiceEnv({
      ...baseConfig,
      env: { NODE_ENV: "production", DATABASE_URL: "override" },
    });

    const command = send.mock.calls[0]![0] as GetParametersCommand;
    expect(command).toBeInstanceOf(GetParametersCommand);
    expect(command.input.WithDecryption).toBe(true);
    expect(command.input.Names).toEqual(["/launch-pad/default/my-app/api/DATABASE_URL"]);
    expect(env).toEqual({
      DATABASE_URL: "override",
      NODE_ENV: "production",
    });
    setSsmClientForTest(null);
  });

  it("returns plain env when there are no secret refs", async () => {
    const send = vi.fn();
    setSsmClientForTest({ send } as never);

    const env = await resolveServiceEnv({ ...baseConfig, secretRefs: [] });

    expect(env).toEqual({ NODE_ENV: "production" });
    expect(send).not.toHaveBeenCalled();
    setSsmClientForTest(null);
  });

  it("fails closed when SSM omits a referenced parameter", async () => {
    const send = vi.fn().mockResolvedValue({ Parameters: [] });
    setSsmClientForTest({ send } as never);

    await expect(resolveServiceEnv(baseConfig)).rejects.toThrow(
      /SSM parameter not found: \/launch-pad\/default\/my-app\/api\/DATABASE_URL/,
    );
    setSsmClientForTest(null);
  });
});
