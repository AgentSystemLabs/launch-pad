import { DescribeImagesCommand } from "@aws-sdk/client-ec2";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { describe, expect, it, vi } from "vitest";
import { CliError } from "../errors";
import { type GoldenAmiEntry, type GoldenAmiManifest, resolveNodeAmi, resolveNodeAmiByRole } from "./golden-ami";

function entry(role: "edge" | "app", amiId: string, architecture: "x86_64" | "arm64" = "x86_64"): GoldenAmiEntry {
  return {
    amiId,
    region: "us-east-1",
    architecture,
    role,
    agentType: "rust",
    agentVersion: "0.0.0",
    builtAt: "2026-06-10T00:00:00.000Z",
  };
}

const manifest: GoldenAmiManifest = {
  schemaVersion: 3,
  defaultAgentType: "rust",
  amis: {
    edge: {
      x86_64: { "us-east-1": entry("edge", "ami-golden-edge-x86") },
      arm64: { "us-east-1": entry("edge", "ami-golden-edge-arm", "arm64") },
    },
    app: {
      x86_64: { "us-east-1": entry("app", "ami-golden-app-x86") },
      arm64: { "us-east-1": entry("app", "ami-golden-app-arm", "arm64") },
    },
  },
};

function ec2(
  images: unknown[] = [
    { ImageId: "ami-golden-edge-x86", State: "available" },
    { ImageId: "ami-golden-app-x86", State: "available" },
    { ImageId: "ami-golden-edge-arm", State: "available" },
    { ImageId: "ami-golden-app-arm", State: "available" },
  ],
) {
  return {
    send: vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(DescribeImagesCommand);
      return { Images: images };
    }),
  };
}

function ssm(amiId = "ami-al2023") {
  return {
    send: vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(GetParameterCommand);
      return { Parameter: { Value: amiId } };
    }),
  };
}

describe("resolveNodeAmi", () => {
  it("uses an explicit AMI with full bootstrap by default", async () => {
    const fakeEc2 = ec2();
    const fakeSsm = ssm();
    const resolved = await resolveNodeAmi(
      {
        ec2: fakeEc2 as never,
        ssm: fakeSsm as never,
        region: "us-east-1",
        role: "app",
        architecture: "x86_64",
        explicitAmiId: "ami-custom",
        env: {},
      },
      manifest,
    );

    expect(resolved).toMatchObject({ imageId: "ami-custom", source: "explicit", bootstrapMode: "full" });
    expect(fakeEc2.send).not.toHaveBeenCalled();
    expect(fakeSsm.send).not.toHaveBeenCalled();
  });

  it("uses LAUNCHPAD_AMI_ID as a golden override by default", async () => {
    const resolved = await resolveNodeAmi(
      {
        ec2: ec2() as never,
        ssm: ssm() as never,
        region: "us-east-1",
        role: "edge",
        architecture: "arm64",
        env: { LAUNCHPAD_AMI_ID: "ami-env" },
      },
      manifest,
    );

    expect(resolved).toMatchObject({ imageId: "ami-env", source: "env", bootstrapMode: "golden" });
  });

  it("picks the ROLE-specific manifest entry when the AMI is visible and available", async () => {
    const edge = await resolveNodeAmi(
      { ec2: ec2() as never, ssm: ssm() as never, region: "us-east-1", role: "edge", architecture: "arm64", env: {} },
      manifest,
    );
    expect(edge).toMatchObject({ imageId: "ami-golden-edge-arm", source: "golden", bootstrapMode: "golden" });
    expect(edge.manifestEntry?.role).toBe("edge");
    expect(edge.manifestEntry?.architecture).toBe("arm64");

    const app = await resolveNodeAmi(
      { ec2: ec2() as never, ssm: ssm() as never, region: "us-east-1", role: "app", architecture: "x86_64", env: {} },
      manifest,
    );
    expect(app).toMatchObject({ imageId: "ami-golden-app-x86", source: "golden", bootstrapMode: "golden" });
    expect(app.manifestEntry?.agentType).toBe("rust");
  });

  it("falls back to AL2023 when the role has no visible AMI", async () => {
    const resolved = await resolveNodeAmi(
      {
        ec2: ec2([{ ImageId: "ami-golden-app", State: "pending" }]) as never,
        ssm: ssm("ami-fallback") as never,
        region: "us-east-1",
        role: "app",
        architecture: "arm64",
        env: {},
      },
      manifest,
    );

    expect(resolved).toMatchObject({ imageId: "ami-fallback", source: "al2023", bootstrapMode: "full" });
  });

  it("falls back to AL2023 when only the OTHER role has a manifest entry", async () => {
    const edgeOnly: GoldenAmiManifest = {
      schemaVersion: 2,
      defaultAgentType: "rust",
      amis: { edge: { "us-east-1": entry("edge", "ami-golden-edge") }, app: {} },
    };
    const resolved = await resolveNodeAmi(
      { ec2: ec2() as never, ssm: ssm("ami-fallback") as never, region: "us-east-1", role: "app", architecture: "x86_64", env: {} },
      edgeOnly,
    );
    expect(resolved).toMatchObject({ imageId: "ami-fallback", source: "al2023", bootstrapMode: "full" });
  });

  it("rejects invalid bootstrap override values", async () => {
    await expect(
      resolveNodeAmi(
        {
          ec2: ec2() as never,
          ssm: ssm() as never,
          region: "us-east-1",
          role: "app",
          architecture: "x86_64",
          explicitAmiId: "ami-custom",
          env: { LAUNCHPAD_AMI_BOOTSTRAP: "fast" },
        },
        manifest,
      ),
    ).rejects.toBeInstanceOf(CliError);
  });
});

describe("resolveNodeAmiByRole", () => {
  it("resolves one AMI per distinct role in a mixed batch", async () => {
    const byRole = await resolveNodeAmiByRole(
      { ec2: ec2() as never, ssm: ssm() as never, region: "us-east-1", env: {} },
      [
        { role: "app", architecture: "arm64" },
        { role: "edge", architecture: "arm64" },
        { role: "app", architecture: "arm64" },
      ],
      manifest,
    );
    expect(byRole.get("edge:arm64")?.imageId).toBe("ami-golden-edge-arm");
    expect(byRole.get("app:arm64")?.imageId).toBe("ami-golden-app-arm");
    expect(byRole.size).toBe(2);
  });
});
