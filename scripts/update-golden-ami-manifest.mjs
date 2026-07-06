#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [packerManifestPath, cliManifestPath, agentVersion, role, architecture] = process.argv.slice(2);

if (
  !packerManifestPath ||
  !cliManifestPath ||
  !agentVersion ||
  !["edge", "app"].includes(role ?? "") ||
  !["x86_64", "arm64"].includes(architecture ?? "")
) {
  console.error(
    "usage: update-golden-ami-manifest.mjs <packer-manifest> <cli-manifest> <agent-version> <edge|app> <x86_64|arm64>",
  );
  process.exit(1);
}

const packer = JSON.parse(readFileSync(resolve(packerManifestPath), "utf8"));
const cli = JSON.parse(readFileSync(resolve(cliManifestPath), "utf8"));
const build = packer.builds?.at(-1);
const artifactId = build?.artifact_id;

if (typeof artifactId !== "string" || !artifactId.includes(":")) {
  throw new Error(`could not read AMI artifact id from ${packerManifestPath}`);
}

const [region, amiId] = artifactId.split(":", 2);
if (!region || !amiId) {
  throw new Error(`unexpected AMI artifact id "${artifactId}"`);
}

const builtAt =
  typeof build.build_time === "number"
    ? new Date(build.build_time * 1000).toISOString()
    : new Date().toISOString();

cli.schemaVersion = 3;
cli.defaultAgentType = "rust";
cli.amis ??= {};
cli.amis.edge ??= {};
cli.amis.app ??= {};
cli.amis[role].x86_64 ??= {};
cli.amis[role].arm64 ??= {};
cli.amis[role][architecture][region] = {
  amiId,
  region,
  architecture,
  role,
  agentType: "rust",
  agentVersion,
  builtAt,
};

writeFileSync(resolve(cliManifestPath), `${JSON.stringify(cli, null, 2)}\n`);
console.error(`updated ${cliManifestPath}: ${role}/${architecture}/${region} -> ${amiId}`);
