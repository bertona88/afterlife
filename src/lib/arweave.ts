import type { ArweaveTag } from "./tags";
import { tagsToMap, tagFirst } from "./tags";

export const AFTERLIFE_TAGS = {
  appName: "ar//afterlife",
  appTag: "afterlife",
  schemaVersion: "1",
  entity: {
    selfHead: "SelfHead",
  },
} as const;

export type ArweaveTxNode = {
  id: string;
  owner: { address: string };
  block: { height: number; timestamp: number } | null;
  tags: ArweaveTag[];
};

export type ArweaveTxEdge = { cursor: string; node: ArweaveTxNode };
type GraphqlResponse<T> = { data?: T; errors?: Array<{ message: string }> };

const DEFAULT_GRAPHQL_ENDPOINTS = ["https://arweave.net/graphql", "https://ar-io.dev/graphql"];
const DEFAULT_GATEWAYS = ["https://arweave.net", "https://ar-io.dev"];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 10_000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function graphqlRequest<T>(
  query: string,
  variables: Record<string, unknown>,
  endpoints: string[] = DEFAULT_GRAPHQL_ENDPOINTS,
): Promise<T> {
  let lastErr: unknown;
  for (const endpoint of endpoints) {
    try {
      const res = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
        timeoutMs: 12_000,
      });
      if (!res.ok) throw new Error(`GraphQL ${endpoint} HTTP ${res.status}`);
      const json = (await res.json()) as GraphqlResponse<T>;
      if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
      if (!json.data) throw new Error(`GraphQL ${endpoint} missing data`);
      return json.data;
    } catch (err) {
      lastErr = err;
      await sleep(120);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("GraphQL request failed");
}

export function getGateways(): string[] {
  const override =
    typeof localStorage !== "undefined" ? localStorage.getItem("afterlifeGatewayUrl") : null;
  const cleaned = override?.trim();
  if (cleaned) return [cleaned, ...DEFAULT_GATEWAYS];
  return DEFAULT_GATEWAYS.slice();
}

export async function fetchTxJson(txId: string, gateways: string[] = getGateways()): Promise<unknown> {
  let lastErr: unknown;
  for (const gw of gateways) {
    const url = `${gw.replace(/\/$/, "")}/${txId}`;
    try {
      const res = await fetchWithTimeout(url, { method: "GET", timeoutMs: 12_000 });
      if (!res.ok) throw new Error(`Gateway ${gw} HTTP ${res.status}`);
      const text = await res.text();
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;
      await sleep(120);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Failed to fetch tx JSON");
}

const LIST_HEADS_QUERY = `
query AfterlifeHeads($tags: [TagFilter!], $first: Int!, $after: String) {
  transactions(tags: $tags, first: $first, after: $after, sort: HEIGHT_DESC) {
    edges {
      cursor
      node {
        id
        owner { address }
        block { height timestamp }
        tags { name value }
      }
    }
  }
}
`;

const LATEST_HEAD_FOR_SELF_QUERY = `
query LatestHeadForSelf($tags: [TagFilter!]) {
  transactions(tags: $tags, first: 1, sort: HEIGHT_DESC) {
    edges {
      node {
        id
        owner { address }
        block { height timestamp }
        tags { name value }
      }
    }
  }
}
`;

function commonAfterlifeHeadTags(): Array<{ name: string; values: string[] }> {
  return [
    { name: "App-Name", values: [AFTERLIFE_TAGS.appName] },
    { name: "App-Tag", values: [AFTERLIFE_TAGS.appTag] },
    { name: "Schema-Version", values: [AFTERLIFE_TAGS.schemaVersion] },
    { name: "Entity", values: [AFTERLIFE_TAGS.entity.selfHead] },
  ];
}

export async function listSelfHeadEdges(params: {
  first: number;
  after?: string | null;
}): Promise<{ edges: ArweaveTxEdge[] }> {
  const data = await graphqlRequest<{ transactions: { edges: ArweaveTxEdge[] } }>(LIST_HEADS_QUERY, {
    tags: commonAfterlifeHeadTags(),
    first: params.first,
    after: params.after ?? null,
  });
  return { edges: data.transactions.edges ?? [] };
}

export async function getLatestSelfHead(selfId: string): Promise<ArweaveTxNode | null> {
  const tags = [...commonAfterlifeHeadTags(), { name: "Self-Id", values: [selfId] }];
  const data = await graphqlRequest<{ transactions: { edges: Array<{ node: ArweaveTxNode }> } }>(
    LATEST_HEAD_FOR_SELF_QUERY,
    { tags },
  );
  return data.transactions.edges?.[0]?.node ?? null;
}

export function groupLatestHeadsBySelfId(edges: ArweaveTxEdge[]): ArweaveTxNode[] {
  const byId = new Map<string, ArweaveTxNode>();
  for (const edge of edges) {
    const node = edge.node;
    const tagMap = tagsToMap(node.tags);
    const selfId = tagFirst(tagMap, "Self-Id") ?? "";
    if (!selfId) continue;
    const existing = byId.get(selfId);
    const nodeHeight = node.block?.height ?? -1;
    const existingHeight = existing?.block?.height ?? -1;
    if (!existing || nodeHeight > existingHeight) byId.set(selfId, node);
  }
  return [...byId.values()].sort((a, b) => (b.block?.height ?? -1) - (a.block?.height ?? -1));
}

