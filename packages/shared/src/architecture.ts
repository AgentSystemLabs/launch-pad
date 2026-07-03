import { z } from "zod";

export const NodeArchitectureSchema = z.enum(["x86_64", "arm64"]);
export type NodeArchitecture = z.infer<typeof NodeArchitectureSchema>;

export function dockerPlatformForArchitecture(architecture: NodeArchitecture): string {
  return architecture === "arm64" ? "linux/arm64" : "linux/amd64";
}

export function caddyArchForArchitecture(architecture: NodeArchitecture): string {
  return architecture === "arm64" ? "arm64" : "amd64";
}

export function rustTargetForArchitecture(architecture: NodeArchitecture): string {
  return architecture === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
}

export function distDirForArchitecture(architecture: NodeArchitecture): string {
  return architecture === "arm64" ? "arm64" : "x86_64";
}

export function parseAwsInstanceArchitecture(values: readonly string[] | undefined): NodeArchitecture | null {
  if (values?.includes("arm64")) return "arm64";
  if (values?.includes("x86_64")) return "x86_64";
  return null;
}
