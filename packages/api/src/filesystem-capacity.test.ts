import { describe, expect, it } from "bun:test";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { statfs } from "node:fs/promises";
import { FilesystemCapacity } from "./filesystem-capacity";

describe("filesystem capacity", () => {
  it("reports total and available bytes without counting reserved blocks as available", () => {
    expect(
      FilesystemCapacity.fromStats({
        bsize: BigInt(4096),
        blocks: BigInt(1000),
        bavail: BigInt(200),
      }),
    ).toEqual({ totalBytes: 4096000, availableBytes: 819200 });
  });

  it("reports no available space for a full disk and rejects unusable capacities", () => {
    expect(
      FilesystemCapacity.fromStats({
        bsize: BigInt(4096),
        blocks: BigInt(1000),
        bavail: BigInt(-2),
      }),
    ).toEqual({ totalBytes: 4096000, availableBytes: 0 });
    expect(
      FilesystemCapacity.fromStats({
        bsize: BigInt(4096),
        blocks: BigInt(0),
        bavail: BigInt(0),
      }),
    ).toBeNull();
    expect(
      FilesystemCapacity.fromStats({
        bsize: BigInt(4096),
        blocks: BigInt(100),
        bavail: BigInt(101),
      }),
    ).toBeNull();
    expect(
      FilesystemCapacity.fromStats({
        bsize: BigInt(4096),
        blocks: BigInt(Number.MAX_SAFE_INTEGER),
        bavail: BigInt(1),
      }),
    ).toBeNull();
  });

  it("returns explicit unavailability when the filesystem cannot be queried", async () => {
    expect(
      await FilesystemCapacity.read(
        path.join(os.tmpdir(), `nimbus-missing-${randomUUID()}`),
      ),
    ).toBeNull();
  });

  it("reads a usable capacity range from the host filesystem when supported", async () => {
    let stats;
    try {
      stats = await statfs(os.tmpdir(), { bigint: true });
    } catch {
      expect(await FilesystemCapacity.read(os.tmpdir())).toBeNull();
      return;
    }
    const capacity = await FilesystemCapacity.read(os.tmpdir());
    if (stats.bsize * stats.blocks <= BigInt(0)) {
      expect(capacity).toBeNull();
      return;
    }
    expect(capacity).not.toBeNull();
    if (capacity === null)
      throw new Error("Host statfs succeeded but no capacity was returned.");
    expect(capacity.totalBytes).toBe(Number(stats.bsize * stats.blocks));
    expect(Number.isSafeInteger(capacity.totalBytes)).toBe(true);
    expect(capacity.totalBytes).toBeGreaterThan(0);
    expect(Number.isSafeInteger(capacity.availableBytes)).toBe(true);
    expect(capacity.availableBytes).toBeGreaterThanOrEqual(0);
    expect(capacity.availableBytes).toBeLessThanOrEqual(capacity.totalBytes);
  });
});
