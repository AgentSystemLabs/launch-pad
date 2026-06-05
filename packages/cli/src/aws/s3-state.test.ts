import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { deletePrefix, listClusterIds } from "./s3-state";

describe("deletePrefix", () => {
  it("lists and batch-deletes every object under the prefix", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Contents: [{ Key: "clusters/e2e/nodes/n1/node.json" }, { Key: "clusters/e2e/nodes/n1/desired.json" }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({});
    const s3 = { send } as never;

    const deleted = await deletePrefix(s3, "bucket", "clusters/e2e/nodes/n1/");

    expect(deleted).toBe(2);
    expect(send.mock.calls[0]![0]).toBeInstanceOf(ListObjectsV2Command);
    const del = send.mock.calls[1]![0] as DeleteObjectsCommand;
    expect(del).toBeInstanceOf(DeleteObjectsCommand);
    expect(del.input.Delete?.Objects).toEqual([
      { Key: "clusters/e2e/nodes/n1/node.json" },
      { Key: "clusters/e2e/nodes/n1/desired.json" },
    ]);
  });

  it("pages through a truncated listing", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Contents: [{ Key: "p/a" }],
        IsTruncated: true,
        NextContinuationToken: "tok",
      })
      .mockResolvedValueOnce({}) // delete batch 1
      .mockResolvedValueOnce({ Contents: [{ Key: "p/b" }], IsTruncated: false })
      .mockResolvedValueOnce({}); // delete batch 2
    const s3 = { send } as never;

    const deleted = await deletePrefix(s3, "bucket", "p/");

    expect(deleted).toBe(2);
    const secondList = send.mock.calls[2]![0] as ListObjectsV2Command;
    expect(secondList.input.ContinuationToken).toBe("tok");
  });

  it("makes no delete call when the prefix is empty", async () => {
    const send = vi.fn().mockResolvedValueOnce({ Contents: [], IsTruncated: false });
    const s3 = { send } as never;

    const deleted = await deletePrefix(s3, "bucket", "empty/");

    expect(deleted).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBeInstanceOf(ListObjectsV2Command);
  });
});

describe("listClusterIds", () => {
  it("returns the named cluster ids under the clusters/ prefix", async () => {
    const send = vi.fn().mockResolvedValueOnce({
      CommonPrefixes: [{ Prefix: "clusters/lower/" }, { Prefix: "clusters/prod/" }],
      IsTruncated: false,
    });
    const s3 = { send } as never;

    const ids = await listClusterIds(s3, "bucket");

    expect(ids).toEqual(["lower", "prod"]);
    const list = send.mock.calls[0]![0] as ListObjectsV2Command;
    expect(list).toBeInstanceOf(ListObjectsV2Command);
    expect(list.input.Prefix).toBe("clusters/");
    expect(list.input.Delimiter).toBe("/");
  });

  it("returns an empty list when no clusters exist", async () => {
    const send = vi.fn().mockResolvedValueOnce({ IsTruncated: false });
    const s3 = { send } as never;
    expect(await listClusterIds(s3, "bucket")).toEqual([]);
  });

  it("pages through a truncated listing", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        CommonPrefixes: [{ Prefix: "clusters/a/" }],
        IsTruncated: true,
        NextContinuationToken: "tok",
      })
      .mockResolvedValueOnce({ CommonPrefixes: [{ Prefix: "clusters/b/" }], IsTruncated: false });
    const s3 = { send } as never;

    const ids = await listClusterIds(s3, "bucket");

    expect(ids).toEqual(["a", "b"]);
    const secondList = send.mock.calls[1]![0] as ListObjectsV2Command;
    expect(secondList.input.ContinuationToken).toBe("tok");
  });
});
