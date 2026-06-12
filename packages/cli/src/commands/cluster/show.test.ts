import { describe, expect, it } from "vitest";
import { summarizeClusterServices } from "./index";

describe("summarizeClusterServices", () => {
  it("sorts by project/service and captures ingress + cron", () => {
    expect(
      summarizeClusterServices([
        {
          project: "shop",
          service: "api",
          replicas: 2,
          image: "123.dkr.ecr.us-east-1.amazonaws.com/shop/api:abc",
          ingress: { domain: "api.example.com" },
        },
        {
          project: "shop",
          service: "worker",
          replicas: 1,
          image: "123.dkr.ecr.us-east-1.amazonaws.com/shop/worker:def",
          ingress: null,
          cron: "0 * * * *",
        },
      ]),
    ).toEqual([
      {
        project: "shop",
        service: "api",
        replicas: 2,
        image: "123.dkr.ecr.us-east-1.amazonaws.com/shop/api:abc",
        domain: "api.example.com",
      },
      {
        project: "shop",
        service: "worker",
        replicas: 1,
        image: "123.dkr.ecr.us-east-1.amazonaws.com/shop/worker:def",
        domain: null,
        cron: "0 * * * *",
      },
    ]);
  });
});
