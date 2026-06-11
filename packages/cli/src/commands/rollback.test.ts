import type { ImageTagPushedAt } from "@agentsystemlabs/launch-pad-shared";
import { describe, expect, it } from "vitest";
import { CliError } from "../errors";
import { resolveRollback } from "./rollback";

const REG = "123456789012.dkr.ecr.us-east-1.amazonaws.com";
const REPO = "shop/web";
const img = (tag: string) => `${REG}/${REPO}:${tag}`;

const history: ImageTagPushedAt[] = [
  { tag: "v1", pushedAt: 1000 },
  { tag: "v2", pushedAt: 2000 },
  { tag: "v3", pushedAt: 3000 },
];

describe("resolveRollback", () => {
  it("auto-picks the previous build and builds the URI in the same repo", () => {
    const res = resolveRollback(img("v3"), history, undefined);
    expect(res).toEqual({ fromTag: "v3", toTag: "v2", uri: img("v2"), noop: false });
  });

  it("honours an explicit --to tag (can roll forward) without consulting history", () => {
    const res = resolveRollback(img("v1"), [], "v3");
    expect(res).toEqual({ fromTag: "v1", toTag: "v3", uri: img("v3"), noop: false });
  });

  it("flags a no-op when --to equals the current tag", () => {
    const res = resolveRollback(img("v2"), [], "v2");
    expect(res.noop).toBe(true);
    expect(res.toTag).toBe("v2");
  });

  it("throws when there is nothing older and no --to", () => {
    expect(() => resolveRollback(img("v1"), history, undefined)).toThrow(/no older image/);
    expect(() => resolveRollback(img("v1"), history, undefined)).toThrow(CliError);
  });

  it("throws when the current image isn't a parseable ECR URI", () => {
    expect(() => resolveRollback("ghcr.io/acme/web:v1", history, undefined)).toThrow(/couldn't parse/);
  });

  it("preserves the registry + repository of the current image when swapping the tag", () => {
    const other = "999999999999.dkr.ecr.eu-west-1.amazonaws.com/proj/api:newest";
    const res = resolveRollback(other, [], "rollback-target");
    expect(res.uri).toBe("999999999999.dkr.ecr.eu-west-1.amazonaws.com/proj/api:rollback-target");
  });
});
