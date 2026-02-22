#!/usr/bin/env node

const GRAPHQL_ENDPOINTS = ["https://arweave.net/graphql", "https://ar-io.dev/graphql"];
const GATEWAYS = ["https://arweave.net", "https://ar-io.dev"];
const EDGE_TYPES = new Set(["supports", "contradicts", "refines", "depends-on", "derived-from"]);

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

function hasAfterlifeNamespace(tags) {
  return (
    tagFirst(tags, "App-Name") === "ar//afterlife" &&
    tagFirst(tags, "App-Tag") === "afterlife" &&
    tagFirst(tags, "Schema-Version") === "1"
  );
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

function validateHeadPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object") errors.push("SelfHead payload is not an object");
  if (payload?.schema !== "afterlife.selfhead@1") errors.push("SelfHead schema must be afterlife.selfhead@1");
  if (typeof payload?.self_id !== "string") errors.push("SelfHead.self_id missing");
  if (typeof payload?.name !== "string") errors.push("SelfHead.name missing");
  if (typeof payload?.snapshot_tx !== "string") errors.push("SelfHead.snapshot_tx missing");
  return errors;
}

function validateSnapshotPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object") errors.push("SelfSnapshot payload is not an object");
  if (payload?.schema !== "afterlife.snapshot@1") errors.push("SelfSnapshot schema must be afterlife.snapshot@1");
  if (typeof payload?.self_id !== "string") errors.push("SelfSnapshot.self_id missing");
  if (!Array.isArray(payload?.ideas) || payload.ideas.length === 0) errors.push("SelfSnapshot.ideas missing/empty");

  const ids = new Set();
  if (Array.isArray(payload?.ideas)) {
    for (const it of payload.ideas) {
      if (!it || typeof it !== "object" || typeof it.idea_id !== "string" || typeof it.tx_id !== "string") {
        errors.push("SelfSnapshot.ideas contains invalid item");
        continue;
      }
      if (ids.has(it.idea_id)) errors.push(`Duplicate idea_id in snapshot: ${it.idea_id}`);
      ids.add(it.idea_id);
    }
  }

  if (Array.isArray(payload?.edges)) {
    for (const edge of payload.edges) {
      if (!edge || typeof edge !== "object") {
        errors.push("SelfSnapshot.edges contains invalid item");
        continue;
      }
      if (!ids.has(edge.from_idea_id) || !ids.has(edge.to_idea_id)) {
        errors.push(`Edge references unknown idea ids: ${JSON.stringify(edge)}`);
      }
      if (!EDGE_TYPES.has(edge.type)) {
        errors.push(`Invalid edge type: ${edge.type}`);
      }
    }
  }

  return errors;
}

async function verifyTx(txId) {
  const [meta] = await getTxMeta([txId]);
  if (!meta) return { ok: false, errors: [`Tx not found: ${txId}`], warnings: [] };
  const tags = tagsToMap(meta.tags);
  const payload = await fetchJsonByTxId(txId);

  const errors = [];
  const warnings = [];
  if (!hasAfterlifeNamespace(tags)) {
    errors.push("Missing required Afterlife namespace tags (App-Name/App-Tag/Schema-Version)");
  }

  const entity = tagFirst(tags, "Entity");
  if (!entity) errors.push("Missing Entity tag");

  if (entity === "SelfHead") {
    errors.push(...validateHeadPayload(payload));
  } else if (entity === "SelfSnapshot") {
    errors.push(...validateSnapshotPayload(payload));
  } else if (entity === "Idea") {
    if (payload?.schema !== "afterlife.idea@1") warnings.push("Idea schema is not afterlife.idea@1");
    if (typeof payload?.idea_id !== "string") warnings.push("Idea payload missing idea_id");
  } else {
    warnings.push(`Unknown or missing entity for tx ${txId}`);
  }

  return {
    ok: errors.length === 0,
    tx_id: txId,
    entity: entity || null,
    tags: Object.fromEntries(tags.entries()),
    errors,
    warnings,
  };
}

async function verifySelf(selfId) {
  const errors = [];
  const warnings = [];

  const latest = await getLatestHead(selfId);
  if (!latest?.id) {
    return {
      ok: false,
      self_id: selfId,
      errors: ["No discoverable SelfHead found for Self-Id"],
      warnings,
    };
  }

  const head = await verifyTx(latest.id);
  if (!head.ok) errors.push(...head.errors.map((e) => `Head: ${e}`));
  warnings.push(...head.warnings.map((w) => `Head: ${w}`));

  const headPayload = await fetchJsonByTxId(latest.id);
  const snapshotTx = headPayload?.snapshot_tx;
  if (typeof snapshotTx !== "string") {
    errors.push("Head payload missing snapshot_tx");
    return { ok: false, self_id: selfId, head_tx: latest.id, errors, warnings };
  }

  const snapshot = await verifyTx(snapshotTx);
  if (!snapshot.ok) errors.push(...snapshot.errors.map((e) => `Snapshot: ${e}`));
  warnings.push(...snapshot.warnings.map((w) => `Snapshot: ${w}`));

  const snapshotPayload = await fetchJsonByTxId(snapshotTx);
  const ideaRefs = Array.isArray(snapshotPayload?.ideas) ? snapshotPayload.ideas : [];
  const ideaReports = [];

  for (const ref of ideaRefs) {
    if (!ref?.tx_id) continue;
    const report = await verifyTx(ref.tx_id);
    if (!report.ok) errors.push(...report.errors.map((e) => `Idea ${ref.idea_id || ref.tx_id}: ${e}`));
    warnings.push(...report.warnings.map((w) => `Idea ${ref.idea_id || ref.tx_id}: ${w}`));
    ideaReports.push({ idea_id: ref.idea_id || null, tx_id: ref.tx_id, ok: report.ok, errors: report.errors, warnings: report.warnings });
  }

  const discoverable = !!latest.id;
  return {
    ok: errors.length === 0,
    self_id: selfId,
    discoverable,
    head_tx: latest.id,
    snapshot_tx: snapshotTx,
    idea_count: ideaReports.length,
    idea_reports: ideaReports,
    errors,
    warnings,
  };
}

async function run() {
  const args = parseArgs(process.argv);
  const txId = args.tx_id;
  const selfId = args.self_id;

  if (!txId && !selfId) throw new Error("Pass --tx_id or --self_id");
  if (txId && selfId) throw new Error("Use either --tx_id or --self_id, not both");

  const result = txId ? await verifyTx(txId) : await verifySelf(selfId);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exit(2);
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
