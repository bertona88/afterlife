---
name: arweave-turbo-save
description: Save files to Arweave through Turbo SDK using a persistent wallet stored in env, with free-first (<100KiB) upload strategy, signed fallback, strict no-paid policy, and security redaction.
---

# Arweave Turbo Save

Use this skill when the user asks to upload or persist files on Arweave with Turbo SDK and wants a zero-fund-first flow.

## Defaults

- Wallet lifecycle: generate once, persist in env, reuse.
- Upload mode: `auto` (try free x402 raw path, fallback to signed data item).
- Index mode: `tags-only`.
- Paid fallback: disabled.
- Compression: off by default (`--compress_if_needed false`), opt-in when needed to fit under free size.
- Max free size: `ARWEAVE_MAX_FREE_BYTES` (default `102400`).

## Required Environment

- `TURBO_UPLOAD_URL` (defaults to `https://upload.ardrive.io`)
- `TURBO_PAYMENT_URL` (defaults to `https://payment.ardrive.io`)
- `TURBO_TOKEN` (defaults to `arweave`; `base-usdc` enables x402 raw uploads)
- `ARWEAVE_JWK_JSON` (auto-generated if missing)

Optional:
- `ARWEAVE_GATEWAY_URL` (default `https://arweave.net`)
- `ARWEAVE_APP_TAG` (default `codex-arweave-skill`)
- `ARWEAVE_MAX_FREE_BYTES` (default `102400`)
- `ARWEAVE_INDEX_MODE` (must be `tags-only`)
- `ARWEAVE_ENV_FILE` (fallback env file path)

Back-compat:
- `TURBO_API_URL` is still accepted, but Turbo uses separate upload + payment services; prefer the split vars.

## Install

```bash
cd /Users/andreabertoncini/.codex/skills/arweave-turbo-save
npm install
```

## Usage

```bash
node scripts/save.mjs \
  --file_path ./path/to/file.txt \
  --tags '{"Topic":"demo"}' \
  --mode auto \
  --compress_if_needed true
```

Arguments:
- `--file_path` (required)
- `--content_type` (optional)
- `--tags` (optional JSON object)
- `--mode` (`auto`, `x402_raw_free`, `signed_data_item`)
- `--compress_if_needed` (`true` or `false`)
- `--name` logical name tag override
- `--env_file` path to `.env`

## Behavior Contract

1. Loads env from `--env_file` or local `.env`.
2. If `ARWEAVE_JWK_JSON` is missing, generates wallet and writes it to env.
3. Enforces max-free bytes, tries gzip/brotli size reduction if needed.
4. Preflights cost quote and never performs paid uploads.
5. Emits structured JSON output with:
- `tx_id`
- `byte_size`
- `sha256`
- `gateway_urls`
- `upload_mode_used`
- `warnings`

## Safety Rules

- Never log wallet key material.
- Warn when env file is not ignored in `.gitignore`.
- Never auto-fund wallet.
- Fail clearly when free policy is unavailable or payload still exceeds free limits.
