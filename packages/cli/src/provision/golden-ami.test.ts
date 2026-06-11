import { DescribeImagesCommand } from "@aws-sdk/client-ec2";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { describe, expect, it, vi } from "vitest";
import { CliError } from "../errors";
import { type GoldenAmiManifest, resolveNodeAmi } from "./golden-ami";

const manifest: GoldenAmiManifest = {
  schemaVersion: 1,
  defaultAgentType: "ts",
  amis: {
    "us-east-1": {
      amiId: "ami-golden",
      region: "us-east-1",
      architecture: "x86_64",
      agentType: "ts",
      agentVersion: "0.0.0",
      builtAt: "2026-06-10T00:00:00.000Z",
    },
  },
};

function ec2(images: unknown[] = [{ ImageId: "ami-golden", State: "available" }]) {
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
      { ec2: fakeEc2 as never, ssm: fakeSsm as never, region: "us-east-1", explicitAmiId: "ami-custom", env: {} },
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
        env: { LAUNCHPAD_AMI_ID: "ami-env" },
      },
      manifest,
    );

    expect(resolved).toMatchObject({ imageId: "ami-env", source: "env", bootstrapMode: "golden" });
  });

  it("uses the region manifest entry when the AMI is visible and available", async () => {
    const resolved = await resolveNodeAmi(
      { ec2: ec2() as never, ssm: ssm() as never, region: "us-east-1", env: {} },
      manifest,
    );

    expect(resolved).toMatchObject({ imageId: "ami-golden", source: "golden", bootstrapMode: "golden" });
  });

  it("falls back to AL2023 when the manifest has no visible AMI", async () => {
    const resolved = await resolveNodeAmi(
      {
        ec2: ec2([{ ImageId: "ami-golden", State: "pending" }]) as never,
        ssm: ssm("ami-fallback") as never,
        region: "us-east-1",
        env: {},
      },
      manifest,
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
          explicitAmiId: "ami-custom",
          env: { LAUNCHPAD_AMI_BOOTSTRAP: "fast" },
        },
        manifest,
      ),
    ).rejects.toBeInstanceOf(CliError);
  });
});
