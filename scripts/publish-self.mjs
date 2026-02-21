#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

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

function asBool(v, fallback = false) {
  if (v == null) return fallback;
  return String(v).toLowerCase() === "true";
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON for ${label}: ${err.message}`);
  }
}

async function readJson(filePath, label) {
  const abs = path.resolve(filePath);
  const raw = await readFile(abs, "utf8");
  return parseJson(raw, label);
}

function resolveSaveScript(explicit) {
  const candidates = [];
  if (explicit) candidates.push(path.resolve(explicit));
  candidates.push(path.resolve(process.cwd(), "skills/arweave-turbo-save/scripts/save.mjs"));
  candidates.push(path.join(os.homedir(), ".codex/skills/arweave-turbo-save/scripts/save.mjs"));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Cannot find arweave-turbo-save script. Tried: ${candidates.join(", ")}. ` +
      "Set --save_script to an explicit path.",
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
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Failed to fetch tx ${txId}`);
}

async function getLatestHeadTx(selfId) {
  const query = `
query LatestHeadForSelf($tags: [TagFilter!]) {
  transactions(tags: $tags, first: 1, sort: HEIGHT_DESC) {
    edges {
      node { id }
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
  return data?.transactions?.edges?.[0]?.node?.id ?? null;
}

function parseSaveOutput(text, stderr) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`save.mjs returned no stdout. stderr: ${stderr || "<empty>"}`);
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(trimmed.slice(first, last + 1));
    }
    throw new Error(`Failed to parse save output JSON. stdout=${trimmed} stderr=${stderr}`);
  }
}

async function runSave(saveScript, opts) {
  const tagsJson = JSON.stringify(opts.tags);
  const args = [
    saveScript,
    "--file_path",
    opts.filePath,
    "--content_type",
    opts.contentType,
    "--tags",
    tagsJson,
    "--mode",
    opts.mode ?? "auto",
    "--compress_if_needed",
    opts.compressIfNeeded ? "true" : "false",
  ];
  if (opts.envFile) {
    args.push("--env_file", path.resolve(opts.envFile));
  }

  const proc = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
  });

  if (proc.status !== 0) {
    throw new Error(
      `save.mjs failed (exit ${proc.status}). stderr: ${(proc.stderr || "").trim()} stdout: ${(proc.stdout || "").trim()}`,
    );
  }
  return parseSaveOutput(proc.stdout || "", proc.stderr || "");
}

function validateInput(input) {
  if (!input || typeof input !== "object") throw new Error("Input must be a JSON object");
  if (typeof input.self_id !== "string" || !input.self_id.trim()) {
    throw new Error("input.self_id is required");
  }
  if (typeof input.name !== "string" || !input.name.trim()) {
    throw new Error("input.name is required");
  }
  if (!Array.isArray(input.ideas) || input.ideas.length === 0) {
    throw new Error("input.ideas must be a non-empty array");
  }
  const seen = new Set();
  for (const idea of input.ideas) {
    if (!idea || typeof idea !== "object") throw new Error("Each idea must be an object");
    if (typeof idea.idea_id !== "string" || !idea.idea_id.trim()) {
      throw new Error("Each idea requires idea_id");
    }
    if (seen.has(idea.idea_id)) {
      throw new Error(`Duplicate idea_id: ${idea.idea_id}`);
    }
    seen.add(idea.idea_id);
    if (!idea.tx_id && idea.content == null) {
      throw new Error(`Idea ${idea.idea_id} must include tx_id or content`);
    }
  }

  if (Array.isArray(input.edges)) {
    for (const edge of input.edges) {
      if (!edge || typeof edge !== "object") throw new Error("Edge entries must be objects");
      if (!seen.has(edge.from_idea_id) || !seen.has(edge.to_idea_id)) {
        throw new Error(`Edge references unknown idea id: ${JSON.stringify(edge)}`);
      }
      if (!EDGE_TYPES.has(edge.type)) {
        throw new Error(`Invalid edge type '${edge.type}'`);
      }
    }
  }
}

function tagsForEntity(entity, input, extra = {}) {
  return {
    "App-Name": "ar//afterlife",
    "App-Tag": "afterlife",
    "Schema-Version": "1",
    Entity: entity,
    "Self-Id": input.self_id,
    ...extra,
  };
}

async function publish() {
  const args = parseArgs(process.argv);
  const inputPath = args.input;
  if (!inputPath) {
    throw new Error(
      "Missing --input <json_file>. Example: node scripts/publish-self.mjs --input ./my-self.publish.json",
    );
  }

  const input = await readJson(inputPath, "input file");
  validateInput(input);

  const saveScript = resolveSaveScript(args.save_script);
  const envFile = args.env_file;
  const verify = asBool(args.verify, true);
  const dryRun = asBool(args.dry_run, false);
  const verifyAttempts = Number.parseInt(args.verify_attempts ?? "8", 10);
  const verifyDelayMs = Number.parseInt(args.verify_delay_ms ?? "1500", 10);

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "afterlife-publish-"));
  const uploadedIdeas = [];

  try {
    for (const idea of input.ideas) {
      if (idea.tx_id) {
        uploadedIdeas.push({
          idea_id: idea.idea_id,
          tx_id: idea.tx_id,
          published: false,
        });
        continue;
      }

      const fileName = `${idea.idea_id}-${randomUUID()}.json`;
      const filePath = path.join(tmpDir, fileName);
      const contentType = idea.content_type || "application/json";
      const payload = contentType.includes("json")
        ? `${JSON.stringify(idea.content, null, 2)}\n`
        : String(idea.content);
      await writeFile(filePath, payload, "utf8");

      if (dryRun) {
        uploadedIdeas.push({
          idea_id: idea.idea_id,
          tx_id: `<dry-run:${idea.idea_id}>`,
          published: false,
        });
        continue;
      }

      const result = await runSave(saveScript, {
        filePath,
        contentType,
        envFile,
        mode: "auto",
        compressIfNeeded: true,
        tags: tagsForEntity("Idea", input, {
          "Idea-Id": idea.idea_id,
          ...(idea.supersedes_tx ? { "Supersedes-Tx": idea.supersedes_tx } : {}),
          ...(idea.tags && typeof idea.tags === "object" ? idea.tags : {}),
        }),
      });

      if (!result.tx_id) throw new Error(`Idea upload for ${idea.idea_id} did not return tx_id`);
      uploadedIdeas.push({ idea_id: idea.idea_id, tx_id: result.tx_id, published: true });
    }

    let parentSnapshotTx = input.parent_snapshot_tx ?? null;
    if (!parentSnapshotTx && asBool(input.auto_parent_from_latest, false)) {
      const latestHeadTx = await getLatestHeadTx(input.self_id);
      if (latestHeadTx) {
        const latestHeadJson = await fetchJsonByTxId(latestHeadTx);
        if (latestHeadJson && typeof latestHeadJson.snapshot_tx === "string") {
          parentSnapshotTx = latestHeadJson.snapshot_tx;
        }
      }
    }

    const snapshotPayload = {
      schema: "afterlife.snapshot@1",
      self_id: input.self_id,
      parent_snapshot_tx: parentSnapshotTx,
      ideas: uploadedIdeas.map((it) => ({ idea_id: it.idea_id, tx_id: it.tx_id })),
      edges: Array.isArray(input.edges) ? input.edges : [],
      notes: typeof input.notes === "string" ? input.notes : undefined,
      created_at: new Date().toISOString(),
    };
    let snapshotTx = "<dry-run:snapshot>";
    if (!dryRun) {
      const snapshotFile = path.join(tmpDir, `snapshot-${input.self_id}-${randomUUID()}.json`);
      await writeFile(snapshotFile, `${JSON.stringify(snapshotPayload, null, 2)}\n`, "utf8");
      const snapshotResult = await runSave(saveScript, {
        filePath: snapshotFile,
        contentType: "application/json",
        envFile,
        mode: "auto",
        compressIfNeeded: true,
        tags: tagsForEntity("SelfSnapshot", input),
      });
      if (!snapshotResult.tx_id) throw new Error("Snapshot upload did not return tx_id");
      snapshotTx = snapshotResult.tx_id;
    }

    const headPayload = {
      schema: "afterlife.selfhead@1",
      self_id: input.self_id,
      name: input.name,
      description: typeof input.description === "string" ? input.description : undefined,
      snapshot_tx: snapshotTx,
      fork_of: input.fork_of ?? undefined,
      owner_address: typeof input.owner_address === "string" ? input.owner_address : undefined,
      updated_at: new Date().toISOString(),
      links: input.links ?? undefined,
    };
    let headTx = "<dry-run:selfhead>";
    if (!dryRun) {
      const headFile = path.join(tmpDir, `selfhead-${input.self_id}-${randomUUID()}.json`);
      await writeFile(headFile, `${JSON.stringify(headPayload, null, 2)}\n`, "utf8");
      const headResult = await runSave(saveScript, {
        filePath: headFile,
        contentType: "application/json",
        envFile,
        mode: "auto",
        compressIfNeeded: true,
        tags: tagsForEntity("SelfHead", input, {
          "Self-Name": input.name,
          ...(input.head_tags && typeof input.head_tags === "object" ? input.head_tags : {}),
        }),
      });
      if (!headResult.tx_id) throw new Error("Head upload did not return tx_id");
      headTx = headResult.tx_id;
    }

    let verification = { enabled: verify, matched: null, latest_head_tx: null, attempts: 0 };
    if (!dryRun && verify) {
      for (let attempt = 1; attempt <= verifyAttempts; attempt += 1) {
        const latest = await getLatestHeadTx(input.self_id);
        verification = {
          enabled: true,
          matched: latest === headTx,
          latest_head_tx: latest,
          attempts: attempt,
        };
        if (verification.matched) break;
        await new Promise((resolve) => setTimeout(resolve, verifyDelayMs));
      }
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          self_id: input.self_id,
          name: input.name,
          publish: {
            idea_txs: uploadedIdeas,
            snapshot_tx: snapshotTx,
            head_tx: headTx,
          },
          payloads: { snapshot: snapshotPayload, head: headPayload },
          verification,
          dry_run: dryRun,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

publish().catch((err) => {
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
