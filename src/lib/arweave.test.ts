import { describe, expect, it, vi } from "vitest";
import { fetchTxJson, groupLatestHeadsBySelfId } from "./arweave";

describe("groupLatestHeadsBySelfId", () => {
  it("selects the highest block height per Self-Id", () => {
    const edges = [
      {
        cursor: "c1",
        node: {
          id: "tx1",
          owner: { address: "o1" },
          block: { height: 10, timestamp: 1 },
          tags: [{ name: "Self-Id", value: "S" }],
        },
      },
      {
        cursor: "c2",
        node: {
          id: "tx2",
          owner: { address: "o1" },
          block: { height: 11, timestamp: 2 },
          tags: [{ name: "Self-Id", value: "S" }],
        },
      },
    ];
    const grouped = groupLatestHeadsBySelfId(edges as any);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.id).toBe("tx2");
  });
});

describe("fetchTxJson", () => {
  it("falls back across gateways", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://gw1/")) throw new Error("network down");
      if (url.startsWith("https://gw2/")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      throw new Error(`unexpected url: ${url}`);
    });
    globalThis.fetch = fetchMock as any;
    try {
      const json = await fetchTxJson("TX", ["https://gw1", "https://gw2"]);
      expect(json).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

