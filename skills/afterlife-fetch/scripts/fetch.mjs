#!/usr/bin/env node

const GRAPHQL_ENDPOINTS = ["https://arweave.net/graphql", "https://ar-io.dev/graphql"];
const GATEWAYS = ["https://arweave.net", "https://ar-io.dev"];

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function asBool(v, fallback = false) {
  if (v == null) return fallback;
  return String(v).toLowerCase() === "true";
}

function tagsToMap(tags = []) {
  const out = new Map();
  for (const tag of tags) {
    const list = out.get(tag.name) || [];
    list.push(tag.value);
    out.set(tag.name, list);
  }
  return out;
}

function tagFirst(tags, name) {
  return tags.get(name)?.[0];
}

function tagCheck(tags) {
  const checks = {
    appName: tagFirst(tags, "App-Name") === "ar//afterlife",
    appTag: tagFirst(tags, "App-Tag") === "afterlife",
    schemaVersion: tagFirst(tags, "Schema-Version") === "1",
    entity: tagFirst(tags, "Entity") || null,
    selfId: tagFirst(tags, "Self-Id") || null,
  };
  return { ...checks, discoverable: checks.appName && checks.appTag && checks.schemaVersion && !!checks.entity };
}

async function postGraphql(query, variables) {
  let lastErr;
  for (const endpoint of GRAPHQL_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}`);
      const json = await res.json();
      if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
      if (!json.data) throw new Error(`${endpoint} missing data`);
      return json.data;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("GraphQL failed");
}

async function fetchJsonByTxId(txId) {
  let lastErr;
  for (const gw of GATEWAYS) {
    const url = `${gw}/${txId}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
      const text = await res.text();
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Failed to fetch tx ${txId}`);
}

async function getTxMeta(txIds) {
  const query = `
query TxMeta($ids: [ID!]!) {
  transactions(ids: $ids) {
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
  const data = await postGraphql(query, { ids: txIds });
  return data.transactions.edges.map((e) => e.node);
}

async function getLatestHead(selfId) {
  const query = `
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
  const tags = [
    { name: "App-Name", values: ["ar//afterlife"] },
    { name: "App-Tag", values: ["afterlife"] },
    { name: "Schema-Version", values: ["1"] },
    { name: "Entity", values: ["SelfHead"] },
    { name: "Self-Id", values: [selfId] },
  ];
  const data = await postGraphql(query, { tags });
  return data?.transactions?.edges?.[0]?.node || null;
}

async function run() {
  const args = parseArgs(process.argv);
  const selfId = args.self_id;
  const txId = args.tx_id;

  if (!selfId && !txId) throw new Error("Pass --self_id or --tx_id");
  if (selfId && txId) throw new Error("Use either --self_id or --tx_id, not both");

  if (txId) {
    const [meta] = await getTxMeta([txId]);
    if (!meta) {
      process.stdout.write(`${JSON.stringify({ ok: true, found: false, tx_id: txId }, null, 2)}\n`);
      return;
    }
    const payload = await fetchJsonByTxId(txId);
    const tags = tagsToMap(meta.tags);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          found: true,
          mode: "tx_id",
          tx: {
            id: meta.id,
            owner: meta.owner,
            block: meta.block,
            tags: Object.fromEntries(tags.entries()),
            tag_check: tagCheck(tags),
          },
          payload,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const includeIdeas = asBool(args.include_ideas, true);
  const ideasLimit = Number.parseInt(args.ideas_limit ?? "50", 10);

  const headMeta = await getLatestHead(selfId);
  if (!headMeta) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          found: false,
          mode: "self_id",
          self_id: selfId,
          reason: "No discoverable SelfHead found for this Self-Id",
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const headTags = tagsToMap(headMeta.tags);
  const headJson = await fetchJsonByTxId(headMeta.id);
  const snapshotTx = typeof headJson?.snapshot_tx === "string" ? headJson.snapshot_tx : null;
  const snapshotJson = snapshotTx ? await fetchJsonByTxId(snapshotTx) : null;

  let ideas = [];
  if (includeIdeas && Array.isArray(snapshotJson?.ideas)) {
    const selected = snapshotJson.ideas.slice(0, Math.max(0, ideasLimit));
    const ideaTxs = selected.map((it) => it?.tx_id).filter((v) => typeof v === "string");
    if (ideaTxs.length > 0) {
      const ideaMetaNodes = await getTxMeta(ideaTxs);
      const byId = new Map(ideaMetaNodes.map((m) => [m.id, m]));
      for (const item of selected) {
        if (!item?.tx_id) continue;
        const meta = byId.get(item.tx_id) || null;
        let ideaPayload = null;
        try {
          ideaPayload = await fetchJsonByTxId(item.tx_id);
        } catch {
          ideaPayload = null;
        }
        ideas.push({
          idea_id: item.idea_id ?? null,
          tx_id: item.tx_id,
          meta: meta
            ? {
                id: meta.id,
                owner: meta.owner,
                block: meta.block,
                tags: Object.fromEntries(tagsToMap(meta.tags).entries()),
                tag_check: tagCheck(tagsToMap(meta.tags)),
              }
            : null,
          payload: ideaPayload,
        });
      }
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        found: true,
        mode: "self_id",
        self_id: selfId,
        head: {
          tx_id: headMeta.id,
          tags: Object.fromEntries(headTags.entries()),
          tag_check: tagCheck(headTags),
          payload: headJson,
        },
        snapshot: snapshotTx
          ? {
              tx_id: snapshotTx,
              payload: snapshotJson,
            }
          : null,
        ideas,
      },
      null,
      2,
    )}\n`,
  );
}

run().catch((err) => {
  process.stderr.write(
    `${JSON.stringify(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      null,
      2,
    )}\n`,
  );
  process.exit(1);
});
