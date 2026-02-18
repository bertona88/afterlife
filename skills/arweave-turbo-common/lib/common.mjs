import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { gunzipSync, brotliDecompressSync } from "node:zlib";


const REDACT_KEYS = [
  "ARWEAVE_JWK_JSON",
  "PRIVATE_KEY",
  "JWK",
  "SECRET",
  "TOKEN",
  "PASSWORD"
];

export function jsonOut(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export function errOut(message, details = {}) {
  const output = {
    ok: false,
    error: message,
    ...sanitize(details)
  };
  process.stderr.write(`${JSON.stringify(output, null, 2)}\n`);
}

export function sanitize(input) {
  if (input == null) {
    return input;
  }
  if (typeof input === "string") {
    let out = input;
    for (const key of REDACT_KEYS) {
      const regex = new RegExp(`${key}=[^\\s]+`, "gi");
      out = out.replace(regex, `${key}=<redacted>`);
    }
    return out;
  }
  if (Array.isArray(input)) {
    return input.map((item) => sanitize(item));
  }
  if (typeof input === "object") {
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      const upperKey = key.toUpperCase();
      if (REDACT_KEYS.some((s) => upperKey.includes(s))) {
        out[key] = "<redacted>";
      } else {
        out[key] = sanitize(value);
      }
    }
    return out;
  }
  return input;
}

export function getEnv(config = {}) {
  const cwd = config.cwd ?? process.cwd();
  const envFile = config.envFile ?? process.env.ARWEAVE_ENV_FILE ?? path.join(cwd, ".env");
  const gateway = process.env.ARWEAVE_GATEWAY_URL ?? "https://arweave.net";
  const appTag = process.env.ARWEAVE_APP_TAG ?? "codex-arweave-skill";
  const maxFreeBytes = Number.parseInt(process.env.ARWEAVE_MAX_FREE_BYTES ?? "102400", 10);

  const DEFAULT_TURBO_UPLOAD_URL = "https://upload.ardrive.io";
  const DEFAULT_TURBO_PAYMENT_URL = "https://payment.ardrive.io";

  const turboApiUrl = (process.env.TURBO_API_URL ?? "").trim();
  const turboUploadUrl = (process.env.TURBO_UPLOAD_URL ?? "").trim();
  const turboPaymentUrl = (process.env.TURBO_PAYMENT_URL ?? "").trim();

  const normalizeUrl = (u) => (u ? String(u).trim().replace(/\/$/, "") : "");

  // Back-compat: TURBO_API_URL used to be a single value; Turbo actually separates
  // upload and payment services. When TURBO_API_URL is provided, infer the missing side.
  let resolvedUploadUrl = "";
  let resolvedPaymentUrl = "";

  if (turboUploadUrl) {
    resolvedUploadUrl = turboUploadUrl;
  }
  if (turboPaymentUrl) {
    resolvedPaymentUrl = turboPaymentUrl;
  }

  if (!resolvedUploadUrl || !resolvedPaymentUrl) {
    if (turboApiUrl) {
      const api = turboApiUrl.toLowerCase();
      if (!resolvedUploadUrl) {
        resolvedUploadUrl = turboApiUrl;
      }
      if (!resolvedPaymentUrl) {
        resolvedPaymentUrl = api.includes("upload.")
          ? DEFAULT_TURBO_PAYMENT_URL
          : api.includes("payment.")
            ? turboApiUrl
            : turboApiUrl;
      }
    }
  }

  if (!resolvedUploadUrl) {
    resolvedUploadUrl = DEFAULT_TURBO_UPLOAD_URL;
  }
  if (!resolvedPaymentUrl) {
    resolvedPaymentUrl = DEFAULT_TURBO_PAYMENT_URL;
  }

  return {
    envFile,
    gateway: gateway.replace(/\/$/, ""),
    appTag,
    maxFreeBytes: Number.isFinite(maxFreeBytes) ? maxFreeBytes : 102400,
    // Prefer split URLs; keep turboUrl for backwards-compat in callers.
    turboUploadUrl: normalizeUrl(resolvedUploadUrl),
    turboPaymentUrl: normalizeUrl(resolvedPaymentUrl),
    turboUrl: normalizeUrl(turboApiUrl || resolvedUploadUrl),
    indexMode: process.env.ARWEAVE_INDEX_MODE ?? "tags-only",
    jwkJson: process.env.ARWEAVE_JWK_JSON
  };
}

export async function ensureEnvGitIgnored(envFile) {
  const cwd = process.cwd();
  const gitIgnorePath = path.join(cwd, ".gitignore");
  const rel = path.relative(cwd, envFile) || ".env";

  try {
    await fs.access(gitIgnorePath);
  } catch {
    return {
      ok: false,
      warning: ".gitignore not found; ensure your env file is not committed.",
      envPath: envFile
    };
  }

  const content = await fs.readFile(gitIgnorePath, "utf8");
  const normalizedLines = content.split(/\r?\n/).map((line) => line.trim());
  const isIgnored = normalizedLines.includes(rel) || normalizedLines.includes(path.basename(envFile));

  if (!isIgnored) {
    return {
      ok: false,
      warning: `${rel} is not listed in .gitignore; add it before storing ARWEAVE_JWK_JSON.`,
      envPath: envFile
    };
  }

  return { ok: true, envPath: envFile };
}

export async function appendEnvVar(envFile, key, value) {
  let original = "";
  try {
    original = await fs.readFile(envFile, "utf8");
  } catch {
    original = "";
  }

  const lines = original.split(/\r?\n/);
  const escaped = value.replace(/\n/g, "").replace(/\r/g, "");
  const newLine = `${key}=${escaped}`;
  const replaced = [];
  let didReplace = false;

  for (const line of lines) {
    if (line.startsWith(`${key}=`)) {
      if (!didReplace) {
        replaced.push(newLine);
        didReplace = true;
      }
      continue;
    }
    replaced.push(line);
  }

  if (!didReplace) {
    if (replaced.length > 0 && replaced[replaced.length - 1] !== "") {
      replaced.push("");
    }
    replaced.push(newLine);
  }

  const next = replaced.join("\n").replace(/\n{3,}/g, "\n\n");
  await fs.writeFile(envFile, `${next}\n`, "utf8");
}

export function fingerprintAddress(address) {
  if (!address || address.length < 12) {
    return address;
  }
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

export function toBase64Url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function normalizeTags(inputTags = {}) {
  return Object.entries(inputTags)
    .filter(([name, value]) => name && value != null)
    .map(([name, value]) => ({ name: String(name), value: String(value) }));
}

export function mergeTags(baseTags, extraTags) {
  const merged = new Map();
  for (const tag of [...baseTags, ...extraTags]) {
    merged.set(tag.name, { name: tag.name, value: tag.value });
  }
  return [...merged.values()];
}

export async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchJsonWithRetry(url, opts = {}) {
  const retries = opts.retries ?? 2;
  const backoffMs = opts.backoffMs ?? 800;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { headers: opts.headers ?? {} });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return await response.json();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await sleep(backoffMs * (attempt + 1));
      }
    }
  }

  throw lastError;
}

export async function fetchBufferWithRetry(url, opts = {}) {
  const retries = opts.retries ?? 2;
  const backoffMs = opts.backoffMs ?? 800;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { headers: opts.headers ?? {} });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      return {
        buffer: Buffer.from(arrayBuffer),
        contentType: response.headers.get("content-type") ?? null
      };
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await sleep(backoffMs * (attempt + 1));
      }
    }
  }

  throw lastError;
}

export async function queryTxByTags({ gateway, tags, ownerAddress, maxResults = 10 }) {
  const endpoint = `${gateway}/graphql`;
  const gqlQuery = `
    query SearchTx($owners: [String!], $tags: [TagFilter!], $first: Int!) {
      transactions(
        first: $first
        owners: $owners
        tags: $tags
        sort: HEIGHT_DESC
      ) {
        edges {
          node {
            id
            owner { address }
            tags { name value }
            block { height timestamp }
          }
        }
      }
    }
  `;

  const body = {
    query: gqlQuery,
    variables: {
      owners: ownerAddress ? [ownerAddress] : null,
      tags: tags.map((tag) => ({ name: tag.name, values: [tag.value] })),
      first: maxResults
    }
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`GraphQL query failed: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  if (json.errors?.length) {
    throw new Error(`GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  }

  return json.data?.transactions?.edges?.map((edge) => edge.node) ?? [];
}

export function decodeByEncoding(buffer, encoding) {
  if (!encoding) {
    return buffer;
  }

  const normalized = encoding.toLowerCase();
  if (normalized === "gzip") {
    return gunzipSync(buffer);
  }
  if (normalized === "br" || normalized === "brotli") {
    return brotliDecompressSync(buffer);
  }

  return buffer;
}

export function coerceBoolean(value, fallback = false) {
  if (value == null) {
    return fallback;
  }
  const normalized = String(value).toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

export function parseJsonArg(raw, fallback = {}) {
  if (!raw) {
    return fallback;
  }
  return JSON.parse(raw);
}
