import { describe, expect, it } from "bun:test";

const loadStatsCache = async () => {
  process.env.NIMBUS_STATS_CACHE_MAX = "1";
  process.env.NIMBUS_STATS_CACHE_TTL_MS = "5";
  const module = await import(`./stats-cache.ts?test=${Date.now()}`);
  module.resetStatsCacheForTest();
  return module;
};

describe("stats-cache bounds", () => {
  it("evicts oldest entries when max size exceeded", async () => {
    const { getStats, setStats } = await loadStatsCache();
    setStats("a.txt", { size: 1, mtime: 1 });
    setStats("b.txt", { size: 2, mtime: 2 });
    expect(getStats("a.txt")).toBeNull();
    expect(getStats("b.txt")).not.toBeNull();
  });

  it("expires entries after TTL", async () => {
    const { getStats, setStats } = await loadStatsCache();
    setStats("c.txt", { size: 3, mtime: 3 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(getStats("c.txt")).toBeNull();
  });
});
