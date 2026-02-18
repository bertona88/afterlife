#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { gzipSync, brotliCompressSync } from "node:zlib";

import Arweave from "arweave";
import dotenv from "dotenv";
import mime from "mime-types";
import { TurboFactory } from "@ardrive/turbo-sdk";

import {
  appendEnvVar,
  coerceBoolean,
  ensureEnvGitIgnored,
  errOut,
  fingerprintAddress,
  getEnv,
  jsonOut,
  mergeTags,
  normalizeTags,
  parseJsonArg,
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
  const winc = quote?.winc ?? null;
  return {
    winc,
    costs
  };
}

function isZeroCost(winc) {
  if (winc == null) {
    return false;
  }
  return String(winc) === "0";
}

function pickPayloadVariants(originalBuffer, opts = {}) {
  const allowCompression = opts.allowCompression ?? true;
  const variants = [
    {
      encoding: "identity",
      contentEncodingTag: null,
      buffer: originalBuffer
    }
  ];

  if (!allowCompression) {
    return variants;
  }

  const gzip = gzipSync(originalBuffer);
  if (gzip.length < originalBuffer.length) {
    variants.push({
      encoding: "gzip",
      contentEncodingTag: "gzip",
      buffer: gzip
    });
  }

  const brotli = brotliCompressSync(originalBuffer);
  if (brotli.length < originalBuffer.length) {
    variants.push({
      encoding: "br",
      contentEncodingTag: "br",
      buffer: brotli
    });
  }

  variants.sort((a, b) => a.buffer.length - b.buffer.length);
  return variants;
}

function chunkOrFail(buffer, maxBytes) {
  const chunks = [];
  const chunkSize = maxBytes;
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    chunks.push(buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length)));
  }
  return chunks;
}

async function uploadRawFree({ turbo, payload, contentType, tags }) {
  return turbo.uploadRawX402Data({
    data: payload,
    dataItemOpts: {
      tags: [
        { name: "Content-Type", value: contentType },
        ...tags
      ]
    }
  });
}

async function uploadSigned({ turbo, payload, contentType, tags }) {
  return turbo.upload({
    data: payload,
    dataItemOpts: {
      tags: [
        { name: "Content-Type", value: contentType },
        ...tags
      ]
    }
  });
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

async function run() {
  const args = parseArgs(process.argv);
  const cwd = process.cwd();
  const envFile = args.env_file ?? path.join(cwd, ".env");
  dotenv.config({ path: envFile, quiet: true });

  const env = getEnv({ envFile });
  const filePath = args.file_path ?? args.file;
  if (!filePath) {
    errOut("Missing required argument --file_path");
    process.exit(1);
  }

  if (env.indexMode !== "tags-only") {
    errOut("Unsupported ARWEAVE_INDEX_MODE", {
      expected: "tags-only",
      received: env.indexMode
    });
    process.exit(1);
  }

  if (!env.turboUploadUrl || !env.turboPaymentUrl) {
    errOut("Missing Turbo service URLs in environment", {
      expected_env: ["TURBO_UPLOAD_URL", "TURBO_PAYMENT_URL"],
      received: {
        TURBO_UPLOAD_URL: env.turboUploadUrl ? "<set>" : "<missing>",
        TURBO_PAYMENT_URL: env.turboPaymentUrl ? "<set>" : "<missing>"
      }
    });
    process.exit(1);
  }

  // Default to identity (no compression). Compression is opt-in because many users
  // expect to fetch JSON as plain text without needing to decode Stored-Encoding.
  const compressIfNeeded = coerceBoolean(args.compress_if_needed, false);
  const mode = args.mode ?? "auto";
  const userTags = parseJsonArg(args.tags, {});

  const gitIgnoreCheck = await ensureEnvGitIgnored(env.envFile);
  const { jwk, address, created } = await createOrLoadWallet({
    envFile: env.envFile,
    jwkJson: env.jwkJson
  });

  const absolutePath = path.resolve(filePath);
  const original = await fs.readFile(absolutePath);
  const originalSha256 = sha256Hex(original);

  const variants = pickPayloadVariants(original, { allowCompression: compressIfNeeded });
  const maxBytes = env.maxFreeBytes;

  let selected = variants.find((variant) => variant.buffer.length <= maxBytes);
  const warnings = [];

  if (!selected && compressIfNeeded) {
    const chunks = chunkOrFail(original, maxBytes);
    if (chunks.length > 1) {
      warnings.push(
        "Payload exceeded max free size and could not be compressed under threshold; chunking would require paid or multi-tx manifest flow."
      );
    }
  }

  if (!selected) {
    errOut("File exceeds free upload threshold and cannot be compressed under limit.", {
      file_path: absolutePath,
      original_bytes: original.length,
      max_free_bytes: maxBytes,
      compress_if_needed: compressIfNeeded,
      paid_fallback_attempted: false
    });
    process.exit(2);
  }

  const inferredType = mime.lookup(absolutePath);
  const contentType = args.content_type ?? inferredType ?? "application/octet-stream";
  const logicalName = args.name ?? path.basename(absolutePath);
  const createdAt = new Date().toISOString();
  const payloadSha256 = sha256Hex(selected.buffer);

  const defaultTags = normalizeTags({
    "App-Name": env.appTag,
    "Logical-Owner": address,
    "Created-At": createdAt,
    "Logical-Name": logicalName,
    "Original-Bytes": String(original.length),
    "Stored-Bytes": String(selected.buffer.length),
    "Original-SHA256": originalSha256,
    "Content-SHA256": payloadSha256,
    "Stored-Encoding": selected.encoding,
    "Skill-Name": "arweave-turbo-save"
  });

  const tags = mergeTags(defaultTags, normalizeTags(userTags));
  if (selected.contentEncodingTag) {
    tags.push({ name: "Content-Encoding", value: selected.contentEncodingTag });
  }

  const unauthenticated = TurboFactory.unauthenticated({
    token: env.turboToken,
    uploadServiceConfig: { url: env.turboUploadUrl },
    paymentServiceConfig: { url: env.turboPaymentUrl }
  });

  // Only create an authenticated client if we actually need signed fallback.
  // Some tokens (e.g. base-usdc) require EVM-style keys; creating an authenticated
  // client eagerly would fail even when we only intend to use unauthenticated x402.
  let authenticated = null;

  const quote = await getWincQuote(unauthenticated, selected.buffer.length);
  const freeEligible = isZeroCost(quote.winc);

  let uploadMode = null;
  let uploadResponse = null;
  const attempts = [];

  if (mode === "auto" || mode === "x402_raw_free") {
    // Free-first: Always try the x402 raw path for <= max free size, even if the
    // quote endpoint reports a non-zero winc. Some environments return non-zero quotes
    // while still allowing a free x402 upload; we only treat it as non-free if upload fails.
    try {
      uploadResponse = await uploadRawFree({
        turbo: unauthenticated,
        payload: selected.buffer,
        contentType,
        tags
      });
      uploadMode = "x402_raw_free";
      attempts.push({
        mode: "x402_raw_free",
        status: "ok",
        free_quote_winc: quote.winc ?? null,
        free_quote_free_eligible: freeEligible
      });
    } catch (error) {
      attempts.push({
        mode: "x402_raw_free",
        status: "failed",
        free_quote_winc: quote.winc ?? null,
        free_quote_free_eligible: freeEligible,
        error: sanitize(error.message)
      });
    }
  }

  if (!uploadResponse && (mode === "auto" || mode === "signed_data_item")) {
    if (!authenticated) {
      authenticated = TurboFactory.authenticated({
        privateKey: jwk,
        token: env.turboToken,
        uploadServiceConfig: { url: env.turboUploadUrl },
        paymentServiceConfig: { url: env.turboPaymentUrl }
      });
    }
    const signedQuote = await getWincQuote(authenticated, selected.buffer.length);
    if (!isZeroCost(signedQuote.winc)) {
      errOut("Signed fallback requires payment; refusing by policy.", {
        signed_winc_quote: signedQuote.winc,
        paid_fallback_attempted: false,
        attempts
      });
      process.exit(3);
    }

    uploadResponse = await uploadSigned({
      turbo: authenticated,
      payload: selected.buffer,
      contentType,
      tags
    });
    uploadMode = "signed_data_item";
    attempts.push({ mode: "signed_data_item", status: "ok" });
  }

  if (!uploadResponse) {
    errOut("All upload modes failed.", { attempts });
    process.exit(4);
  }

  const txId = extractUploadId(uploadResponse);
  if (!txId) {
    errOut("Upload succeeded but no transaction id was returned.", {
      mode: uploadMode,
      response: sanitize(uploadResponse)
    });
    process.exit(5);
  }

  const out = {
    ok: true,
    tx_id: txId,
    byte_size: selected.buffer.length,
    sha256: payloadSha256,
    original_sha256: originalSha256,
    original_bytes: original.length,
    content_type: contentType,
    upload_mode_used: uploadMode,
    gateway_urls: [
      `${env.gateway}/${txId}`,
      `https://ar-io.dev/${txId}`
    ],
    warnings: [
      ...warnings,
      ...(gitIgnoreCheck.ok ? [] : [gitIgnoreCheck.warning]),
      ...(created
        ? [
            `Generated new wallet and wrote ARWEAVE_JWK_JSON to ${env.envFile}. Address fingerprint: ${fingerprintAddress(address)}`
          ]
        : [])
    ],
    attempts,
    tags_applied: tags,
    free_quote_winc: quote.winc,
    wallet_address_fingerprint: fingerprintAddress(address)
  };

  jsonOut(out);
}

run().catch((error) => {
  errOut("Upload script failed", {
    details: sanitize(error.stack || error.message)
  });
  process.exit(1);
});
