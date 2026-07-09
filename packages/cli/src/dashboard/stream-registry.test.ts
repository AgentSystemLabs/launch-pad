import { afterEach, describe, expect, it } from "vitest";
import {
  joinRoom,
  leaveRoom,
  MAX_LIVE_ROOMS,
  RoomCapExceededError,
  stopAllRooms,
} from "./stream-registry";

const noopStart = () => ({ stop: () => {} });

afterEach(() => stopAllRooms());

describe("room cap (subprocess-exhaustion DoS)", () => {
  it("caps the number of simultaneously-live rooms", () => {
    for (let i = 0; i < MAX_LIVE_ROOMS; i++) {
      joinRoom({ key: `k${i}`, start: noopStart });
    }
    expect(() => joinRoom({ key: "overflow", start: noopStart })).toThrow(RoomCapExceededError);
  });

  it("still lets viewers JOIN an already-live room at the cap (no eviction)", () => {
    for (let i = 0; i < MAX_LIVE_ROOMS; i++) {
      joinRoom({ key: `k${i}`, start: noopStart });
    }
    // Joining an existing room only bumps a ref count — must not throw.
    expect(() => joinRoom({ key: "k0", start: noopStart })).not.toThrow();
  });

  it("frees a slot when a room is fully left", () => {
    for (let i = 0; i < MAX_LIVE_ROOMS; i++) {
      joinRoom({ key: `k${i}`, start: noopStart });
    }
    leaveRoom("k0"); // room k0 had a single ref → torn down, slot freed
    expect(() => joinRoom({ key: "fresh", start: noopStart })).not.toThrow();
  });
});
