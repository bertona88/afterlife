#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";

import Arweave from "arweave";
import dotenv from "dotenv";
import mime from "mime-types";
import { TurboFactory } from "@ardrive/turbo-sdk";

const GRAPHQL_ENDPOINTS = ["https://arweave.net/graphql", "https://ar-io.dev/graphql"];
const GATEWAYS = ["https://arweave.net", "https://ar-io.dev"];
const EDGE_TYPES = new Set(["supports", "contradicts", "refines", "depends-on", "derived-from"]);
const REDACT_KEYS = ["ARWEAVE_JWK_JSON", "PRIVATE_KEY", "JWK", "SECRET", "TOKEN", "PASSWORD"];
const HARD_SECRET_PATTERNS = [
  /-----BEGIN (?:RSA|EC|OPENSSH|PGP) PRIVATE KEY-----/i,
  /"?ARWEAVE_JWK_JSON"?\s*[:=]/i,
  /"?private[_-]?key"?\s*[:=]/i,
  /"?seed[_-]?phrase"?\s*[:=]/i,
  /"?mnemonic"?\s*[:=]/i,
  /"?api[_-]?key"?\s*[:=]/i,
  /"?bearer"?\s*[:=]/i,
  /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/,
];

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

function sanitize(input) {
  if (input == null) return input;
  if (typeof input === "string") {
    let out = input;
    for (const key of REDACT_KEYS) {
      out = out.replace(new RegExp(`${key}=[^\\s]+`, "gi"), `${key}=<redacted>`);
    }
    return out;
  }
  if (Array.isArray(input)) return input.map((item) => sanitize(item));
  if (typeof input === "object") {
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      out[key] = REDACT_KEYS.some((token) => key.toUpperCase().includes(token)) ? "<redacted>" : sanitize(value);
    }
    return out;
  }
  return input;
}

function jsonOut(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function errOut(message, details = {}) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: message, ...sanitize(details) }, null, 2)}\n`);
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function normalizeTags(inputTags = {}) {
  return Object.entries(inputTags)
    .filter(([name, value]) => name && value != null)
    .map(([name, value]) => ({ name: String(name), value: String(value) }));
}

function mergeTags(baseTags, extraTags) {
  const merged = new Map();
  for (const tag of [...baseTags, ...extraTags]) {
    merged.set(tag.name, { name: tag.name, value: tag.value });
  }
  return [...merged.values()];
}

async function appendEnvVar(envFile, key, value) {
  let original = "";
  try {
    original = await readFile(envFile, "utf8");
  } catch {
    original = "";
  }

  const lines = original.split(/\r?\n/);
  const nextLine = `${key}=${String(value).replace(/\r/g, "").replace(/\n/g, "")}`;
  const replaced = [];
  let didReplace = false;

  for (const line of lines) {
    if (line.startsWith(`${key}=`)) {
      if (!didReplace) replaced.push(nextLine);
      didReplace = true;
      continue;
    }
    replaced.push(line);
  }

  if (!didReplace) {
    if (replaced.length > 0 && replaced[replaced.length - 1] !== "") replaced.push("");
    replaced.push(nextLine);
  }

  await writeFile(envFile, `${replaced.join("\n").replace(/\n{3,}/g, "\n\n")}\n`, "utf8");
}

async function ensureEnvGitIgnored(envFile) {
  const cwd = process.cwd();
  const gitIgnorePath = path.join(cwd, ".gitignore");
  const rel = path.relative(cwd, envFile) || ".env";

  if (!existsSync(gitIgnorePath)) {
    return {
      ok: false,
      warning: ".gitignore not found; ensure your env file is not committed.",
      envPath: envFile,
    };
  }

  const content = await readFile(gitIgnorePath, "utf8");
  const normalizedLines = content.split(/\r?\n/).map((line) => line.trim());
  const isIgnored = normalizedLines.includes(rel) || normalizedLines.includes(path.basename(envFile));

  if (!isIgnored) {
    return {
      ok: false,
      warning: `${rel} is not listed in .gitignore; add it before storing ARWEAVE_JWK_JSON.`,
      envPath: envFile,
    };
  }

  return { ok: true, envPath: envFile };
}

function fingerprintAddress(address) {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

function getEnv(config = {}) {
  const cwd = config.cwd ?? process.cwd();
  const envFile = config.envFile ?? process.env.ARWEAVE_ENV_FILE ?? path.join(cwd, ".env");
  const gateway = process.env.ARWEAVE_GATEWAY_URL ?? "https://arweave.net";
  const maxFreeBytes = Number.parseInt(process.env.ARWEAVE_MAX_FREE_BYTES ?? "102400", 10);
  const turboApiUrl = (process.env.TURBO_API_URL ?? "").trim();
  const turboUploadUrl = (process.env.TURBO_UPLOAD_URL ?? "").trim();
  const turboPaymentUrl = (process.env.TURBO_PAYMENT_URL ?? "").trim();
  const turboToken = (process.env.TURBO_TOKEN ?? "").trim() || "arweave";

  const defaultUploadUrl = "https://upload.ardrive.io";
  const defaultPaymentUrl = "https://payment.ardrive.io";
  const normalizeUrl = (value) => (value ? String(value).trim().replace(/\/$/, "") : "");

  let resolvedUploadUrl = turboUploadUrl;
  let resolvedPaymentUrl = turboPaymentUrl;

  if ((!resolvedUploadUrl || !resolvedPaymentUrl) && turboApiUrl) {
    if (!resolvedUploadUrl) resolvedUploadUrl = turboApiUrl;
    if (!resolvedPaymentUrl) {
      const api = turboApiUrl.toLowerCase();
      resolvedPaymentUrl = api.includes("upload.") ? defaultPaymentUrl : turboApiUrl;
    }
  }

  return {
    envFile,
    gateway: gateway.replace(/\/$/, ""),
    maxFreeBytes: Number.isFinite(maxFreeBytes) ? maxFreeBytes : 102400,
    turboUploadUrl: normalizeUrl(resolvedUploadUrl || defaultUploadUrl),
    turboPaymentUrl: normalizeUrl(resolvedPaymentUrl || defaultPaymentUrl),
    turboToken,
    indexMode: process.env.ARWEAVE_INDEX_MODE ?? "tags-only",
    jwkJson: process.env.ARWEAVE_JWK_JSON,
  };
}

function detectSecret(text) {
  for (const pattern of HARD_SECRET_PATTERNS) {
    if (pattern.test(text)) return pattern.toString();
  }
  return null;
}

function validateInput(input) {
  if (!input || typeof input !== "object") throw new Error("Input must be a JSON object");
  if (typeof input.self_id !== "string" || !input.self_id.trim()) throw new Error("input.self_id is required");
  if (typeof input.name !== "string" || !input.name.trim()) throw new Error("input.name is required");
  if (!Array.isArray(input.ideas) || input.ideas.length === 0) throw new Error("input.ideas must be a non-empty array");

  const seen = new Set();
  for (const idea of input.ideas) {
    if (!idea || typeof idea !== "object") throw new Error("Each idea must be an object");
    if (typeof idea.idea_id !== "string" || !idea.idea_id.trim()) throw new Error("Each idea requires idea_id");
    if (seen.has(idea.idea_id)) throw new Error(`Duplicate idea_id: ${idea.idea_id}`);
    seen.add(idea.idea_id);
    if (!idea.tx_id && idea.content == null) throw new Error(`Idea ${idea.idea_id} must include tx_id or content`);

    if (idea.content != null) {
      const text = typeof idea.content === "string" ? idea.content : JSON.stringify(idea.content);
      const match = detectSecret(text);
      if (match) throw new Error(`Idea ${idea.idea_id} appears to include secret material (${match}). Refusing upload.`);
    }
  }

  if (Array.isArray(input.edges)) {
    for (const edge of input.edges) {
      if (!edge || typeof edge !== "object") throw new Error("Edge entries must be objects");
      if (!seen.has(edge.from_idea_id) || !seen.has(edge.to_idea_id)) {
        throw new Error(`Edge references unknown idea id: ${JSON.stringify(edge)}`);
      }
      if (!EDGE_TYPES.has(edge.type)) throw new Error(`Invalid edge type '${edge.type}'`);
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

function buildIdeaPayload(input, idea) {
  if (idea.content_type && !String(idea.content_type).includes("json")) return String(idea.content);
  if (idea.content && typeof idea.content === "object" && idea.content.schema) return idea.content;
  return {
    schema: "afterlife.idea@1",
    self_id: input.self_id,
    idea_id: idea.idea_id,
    kind: typeof idea.kind === "string" ? idea.kind : "note",
    content: idea.content,
    created_at: new Date().toISOString(),
  };
}

function pickPayloadVariants(originalBuffer, allowCompression) {
  const variants = [{ encoding: "identity", contentEncodingTag: null, buffer: originalBuffer }];
  if (!allowCompression) return variants;

  const gzip = gzipSync(originalBuffer);
  if (gzip.length < originalBuffer.length) {
    variants.push({ encoding: "gzip", contentEncodingTag: "gzip", buffer: gzip });
  }

  const brotli = brotliCompressSync(originalBuffer);
  if (brotli.length < originalBuffer.length) {
    variants.push({ encoding: "br", contentEncodingTag: "br", buffer: brotli });
  }

  variants.sort((a, b) => a.buffer.length - b.buffer.length);
  return variants;
}

async function createOrLoadWallet({ envFile, jwkJson }) {
  const arweave = Arweave.init({ host: "arweave.net", port: 443, protocol: "https" });
  if (jwkJson) {
    const jwk = JSON.parse(jwkJson);
    const address = await arweave.wallets.jwkToAddress(jwk);
    return { jwk, address, created: false };
  }

  const jwk = await arweave.wallets.generate();
  const address = await arweave.wallets.jwkToAddress(jwk);
  await appendEnvVar(envFile, "ARWEAVE_JWK_JSON", JSON.stringify(jwk));
  return { jwk, address, created: true };
}

function extractUploadId(response) {
  return (
    response?.id ??
    response?.data?.id ??
    response?.transactionId ??
    response?.dataItemId ??
    response?.fastFinalityIndexes?.id ??
    null
  );
}

async function getWincQuote(turboClient, byteCount) {
  const costs = await turboClient.getUploadCosts({ bytes: [byteCount] });
  const quote = costs?.[0] ?? null;
  return { winc: quote?.winc ?? null };
}

function isZeroCost(winc) {
  return winc != null && String(winc) === "0";
}

async function uploadRawFree({ turbo, payload, contentType, tags }) {
  return turbo.uploadRawX402Data({
    data: payload,
    tags: [{ name: "Content-Type", value: contentType }, ...tags],
  });
}

async function uploadSigned({ turbo, payload, contentType, tags }) {
  return turbo.upload({
    data: payload,
    dataItemOpts: {
      tags: [{ name: "Content-Type", value: contentType }, ...tags],
    },
  });
}

async function uploadFile({ filePath, contentType, logicalName, envFile, extraTags, mode = "auto", compressIfNeeded = false }) {
  dotenv.config({ path: envFile, quiet: true });
  const env = getEnv({ envFile });

  if (env.indexMode !== "tags-only") {
    throw new Error(`Unsupported ARWEAVE_INDEX_MODE '${env.indexMode}'. Expected 'tags-only'.`);
  }

  const gitIgnoreCheck = await ensureEnvGitIgnored(env.envFile);
  const { jwk, address, created } = await createOrLoadWallet({
    envFile: env.envFile,
    jwkJson: env.jwkJson,
  });

  const absolutePath = path.resolve(filePath);
  const original = await readFile(absolutePath);
  const originalSha256 = sha256Hex(original);
  const variants = pickPayloadVariants(original, compressIfNeeded);
  const selected = variants.find((variant) => variant.buffer.length <= env.maxFreeBytes);

  if (!selected) {
    throw new Error(
      `File exceeds free upload threshold and cannot be compressed under limit (${env.maxFreeBytes} bytes).`,
    );
  }

  const inferredType = mime.lookup(absolutePath);
  const resolvedContentType = contentType ?? inferredType ?? "application/octet-stream";
  const createdAt = new Date().toISOString();
  const payloadSha256 = sha256Hex(selected.buffer);

  const defaultTags = normalizeTags({
    "App-Name": "ar//afterlife",
    "Logical-Owner": address,
    "Created-At": createdAt,
    "Logical-Name": logicalName ?? path.basename(absolutePath),
    "Original-Bytes": String(original.length),
    "Stored-Bytes": String(selected.buffer.length),
    "Original-SHA256": originalSha256,
    "Content-SHA256": payloadSha256,
    "Stored-Encoding": selected.encoding,
    "Skill-Name": "afterlife-publish",
  });

  const tags = mergeTags(defaultTags, normalizeTags(extraTags));
  if (selected.contentEncodingTag) {
    tags.push({ name: "Content-Encoding", value: selected.contentEncodingTag });
  }

  const unauthenticated = TurboFactory.unauthenticated({
    token: env.turboToken,
    uploadServiceConfig: { url: env.turboUploadUrl },
    paymentServiceConfig: { url: env.turboPaymentUrl },
  });

  const quote = await getWincQuote(unauthenticated, selected.buffer.length);
  const attempts = [];
  let uploadResponse = null;
  let uploadMode = null;

  if (mode === "auto" || mode === "x402_raw_free") {
    try {
      uploadResponse = await uploadRawFree({
        turbo: unauthenticated,
        payload: selected.buffer,
        contentType: resolvedContentType,
        tags,
      });
      uploadMode = "x402_raw_free";
      attempts.push({
        mode: "x402_raw_free",
        status: "ok",
        free_quote_winc: quote.winc ?? null,
        free_quote_free_eligible: isZeroCost(quote.winc),
      });
    } catch (error) {
      attempts.push({
        mode: "x402_raw_free",
        status: "failed",
        free_quote_winc: quote.winc ?? null,
        free_quote_free_eligible: isZeroCost(quote.winc),
        error: sanitize(error.message),
      });
    }
  }

  if (!uploadResponse && (mode === "auto" || mode === "signed_data_item")) {
    const authenticated = TurboFactory.authenticated({
      privateKey: jwk,
      token: env.turboToken,
      uploadServiceConfig: { url: env.turboUploadUrl },
      paymentServiceConfig: { url: env.turboPaymentUrl },
    });
    const signedQuote = await getWincQuote(authenticated, selected.buffer.length);
    if (!isZeroCost(signedQuote.winc)) {
      throw new Error(
        `Signed fallback requires payment (${signedQuote.winc}); refusing by policy.`,
      );
    }

    uploadResponse = await uploadSigned({
      turbo: authenticated,
      payload: selected.buffer,
      contentType: resolvedContentType,
      tags,
    });
    uploadMode = "signed_data_item";
    attempts.push({ mode: "signed_data_item", status: "ok" });
  }

  if (!uploadResponse) throw new Error("All upload modes failed.");

  const txId = extractUploadId(uploadResponse);
  if (!txId) throw new Error("Upload succeeded but no transaction id was returned.");

  return {
    ok: true,
    tx_id: txId,
    byte_size: selected.buffer.length,
    sha256: payloadSha256,
    original_sha256: originalSha256,
    original_bytes: original.length,
    content_type: resolvedContentType,
    upload_mode_used: uploadMode,
    gateway_urls: [`${env.gateway}/${txId}`, `https://ar-io.dev/${txId}`],
    warnings: [
      ...(gitIgnoreCheck.ok ? [] : [gitIgnoreCheck.warning]),
      ...(created
        ? [
            `Generated new wallet and wrote ARWEAVE_JWK_JSON to ${env.envFile}. Address fingerprint: ${fingerprintAddress(address)}`,
          ]
        : []),
    ],
    attempts,
    tags_applied: tags,
    free_quote_winc: quote.winc,
    wallet_address_fingerprint: fingerprintAddress(address),
  };
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

async function publish() {
  const args = parseArgs(process.argv);
  if (!args.input) throw new Error("Missing --input <json_file>");

  const input = await readJson(args.input, "input file");
  validateInput(input);

  const envFile = path.resolve(args.env_file ?? path.join(process.cwd(), ".env"));
  const verify = asBool(args.verify, true);
  const dryRun = asBool(args.dry_run, false);
  const verifyAttempts = Number.parseInt(args.verify_attempts ?? "8", 10);
  const verifyDelayMs = Number.parseInt(args.verify_delay_ms ?? "1500", 10);

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "afterlife-publish-"));
  const uploadedIdeas = [];
  const uploadWarnings = [];

  try {
    for (const idea of input.ideas) {
      if (idea.tx_id) {
        uploadedIdeas.push({ idea_id: idea.idea_id, tx_id: idea.tx_id, published: false });
        continue;
      }

      const filePath = path.join(tmpDir, `${idea.idea_id}-${randomUUID()}.json`);
      const contentType = idea.content_type || "application/json";
      const payload = buildIdeaPayload(input, idea);
      const body = String(contentType).includes("json") ? `${JSON.stringify(payload, null, 2)}\n` : String(payload);
      await writeFile(filePath, body, "utf8");

      if (dryRun) {
        uploadedIdeas.push({ idea_id: idea.idea_id, tx_id: `<dry-run:${idea.idea_id}>`, published: false });
        continue;
      }

      const result = await uploadFile({
        filePath,
        contentType,
        logicalName: `${input.self_id}-${idea.idea_id}.json`,
        envFile,
        extraTags: tagsForEntity("Idea", input, {
          "Idea-Id": idea.idea_id,
          ...(idea.supersedes_tx ? { "Supersedes-Tx": idea.supersedes_tx } : {}),
          ...(idea.tags && typeof idea.tags === "object" ? idea.tags : {}),
        }),
      });

      uploadWarnings.push(...result.warnings);
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
      const snapshotResult = await uploadFile({
        filePath: snapshotFile,
        contentType: "application/json",
        logicalName: `${input.self_id}-snapshot.json`,
        envFile,
        extraTags: tagsForEntity("SelfSnapshot", input),
      });
      uploadWarnings.push(...snapshotResult.warnings);
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
      const headResult = await uploadFile({
        filePath: headFile,
        contentType: "application/json",
        logicalName: `${input.self_id}-selfhead.json`,
        envFile,
        extraTags: tagsForEntity("SelfHead", input, {
          "Self-Name": input.name,
          ...(input.head_tags && typeof input.head_tags === "object" ? input.head_tags : {}),
        }),
      });
      uploadWarnings.push(...headResult.warnings);
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

    jsonOut({
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
      warnings: [...new Set(uploadWarnings)],
      dry_run: dryRun,
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

publish().catch((err) => {
  errOut("Afterlife publish failed", {
    details: err instanceof Error ? err.stack || err.message : String(err),
  });
  process.exit(1);
});
