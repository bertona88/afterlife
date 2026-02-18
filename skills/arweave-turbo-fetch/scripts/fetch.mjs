#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";

import dotenv from "dotenv";

import {
  decodeByEncoding,
  errOut,
  fetchBufferWithRetry,
  fingerprintAddress,
  getEnv,
  jsonOut,
  mergeTags,
  normalizeTags,
  parseJsonArg,
  queryTxByTags,
  sanitize,
  sha256Hex
} from "../../arweave-turbo-common/lib/common.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part.startsWith("--")) {
      continue;
    }
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

function uniqueGateways(primary) {
  const list = [primary, "https://arweave.net", "https://ar-io.dev"];
  return [...new Set(list.map((item) => item.replace(/\/$/, "")))];
}

function tagsToMap(tags = []) {
  const out = {};
  for (const tag of tags) {
    out[tag.name] = tag.value;
  }
  return out;
}

function pickContentEncoding({ argEncoding, txTags }) {
  if (argEncoding) {
    return argEncoding;
  }

  return txTags["Content-Encoding"] || txTags["Stored-Encoding"] || null;
}

async function resolveTxByTags({ gateways, ownerAddress, tags }) {
  for (const gateway of gateways) {
    try {
      const nodes = await queryTxByTags({
        gateway,
        ownerAddress,
        tags,
        maxResults: 10
      });
      if (nodes.length > 0) {
        return {
          tx: nodes[0],
          gateway,
          tried: [{ gateway, status: "ok", count: nodes.length }]
        };
      }
    } catch (error) {
      // Continue with fallback gateways.
    }
  }
  return null;
}

async function fetchTxData({ txId, gateways }) {
  const attempts = [];
  for (const gateway of gateways) {
    const url = `${gateway}/${txId}`;
    try {
      const result = await fetchBufferWithRetry(url, { retries: 2, backoffMs: 700 });
      attempts.push({ gateway, status: "ok" });
      return { ...result, gateway, attempts };
    } catch (error) {
      attempts.push({ gateway, status: "failed", error: sanitize(error.message) });
    }
  }

  throw new Error(`Unable to fetch transaction data for ${txId}: ${JSON.stringify(attempts)}`);
}

async function run() {
  const args = parseArgs(process.argv);
  const envFile = args.env_file ?? path.join(process.cwd(), ".env");
  dotenv.config({ path: envFile, quiet: true });

  const env = getEnv({ envFile });
  const gateways = uniqueGateways(env.gateway);
  const ownerAddress = args.owner_address;
  const expectedHash = args.expected_hash;

  const txIdArg = args.tx_id;
  let txId = txIdArg;
  let txTags = {};
  let discovery = {
    mode: txIdArg ? "tx_id" : "tags",
    gateways
  };

  if (!txId) {
    const tupleTags = normalizeTags({
      "App-Name": args.app_tag ?? env.appTag,
      "Content-SHA256": args.hash,
      "Logical-Name": args.name,
      "Created-At": args.created_at
    });

    const extraTags = normalizeTags(parseJsonArg(args.tags, {}));
    const queryTags = mergeTags(tupleTags, extraTags).filter((tag) => tag.value && tag.value !== "undefined");

    if (queryTags.length === 0) {
      errOut("Fetch by tags requires at least one tag filter.", {
        accepted_filters: ["app_tag", "hash", "name", "created_at", "tags"]
      });
      process.exit(2);
    }

    const resolved = await resolveTxByTags({
      gateways,
      ownerAddress,
      tags: queryTags
    });

    if (!resolved) {
      jsonOut({
        ok: true,
        found: false,
        reason: "No matching transaction found via tag queries.",
        query_tags: queryTags,
        owner_address_fingerprint: ownerAddress ? fingerprintAddress(ownerAddress) : null
      });
      return;
    }

    txId = resolved.tx.id;
    txTags = tagsToMap(resolved.tx.tags);
    discovery = {
      mode: "tags",
      resolved_by_gateway: resolved.gateway,
      query_tags: queryTags,
      owner_address_fingerprint: ownerAddress ? fingerprintAddress(ownerAddress) : null
    };
  }

  const fetched = await fetchTxData({ txId, gateways });
  const encoding = pickContentEncoding({ argEncoding: args.content_encoding, txTags });
  const decodedBuffer = decodeByEncoding(fetched.buffer, encoding);
  const decodedHash = sha256Hex(decodedBuffer);
  const rawHash = sha256Hex(fetched.buffer);

  const expected = expectedHash || txTags["Original-SHA256"] || txTags["Content-SHA256"] || null;
  const integrityCheck = expected
    ? {
        expected,
        actual: decodedHash,
        matched: expected === decodedHash
      }
    : {
        expected: null,
        actual: decodedHash,
        matched: null
      };

  let savedTo = null;
  if (args.output_path) {
    savedTo = path.resolve(args.output_path);
    await fs.mkdir(path.dirname(savedTo), { recursive: true });
    await fs.writeFile(savedTo, decodedBuffer);
  }

  jsonOut({
    ok: true,
    found: true,
    tx_id: txId,
    bytes: decodedBuffer.length,
    raw_bytes: fetched.buffer.length,
    content_type: fetched.contentType,
    saved_to: savedTo,
    gateway_used: fetched.gateway,
    gateway_attempts: fetched.attempts,
    stored_encoding: encoding,
    sha256: decodedHash,
    raw_sha256: rawHash,
    integrity_check: integrityCheck,
    tx_tags: txTags,
    discovery
  });
}

run().catch((error) => {
  errOut("Fetch script failed", {
    details: sanitize(error.stack || error.message)
  });
  process.exit(1);
});
