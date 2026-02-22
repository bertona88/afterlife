---
name: arweave-turbo-fetch
description: Fetch Arweave files by transaction id or tag queries using gateway fallbacks, decode stored encodings, and verify integrity hashes for uploads created by arweave-turbo-save.
---

# Arweave Turbo Fetch

> Note: For ar//afterlife protocol reads, prefer `afterlife-fetch`/`afterlife-verify` in this repo.
> This skill remains a generic low-level fetcher.

Use this skill when the user asks to retrieve files from Arweave by tx id or by tags.

## Defaults

- Discovery mode: `tx_id` if provided, otherwise tag query.
- Gateway fallback order: `ARWEAVE_GATEWAY_URL`, `https://arweave.net`, `https://ar-io.dev`.
- Integrity: verify against `--expected_hash` or upload tags when present.

## Required Environment

- `ARWEAVE_GATEWAY_URL` (optional; defaults to `https://arweave.net`)
- `ARWEAVE_APP_TAG` (optional; defaults to `codex-arweave-skill`)

## Install

```bash
cd ~/.codex/skills/arweave-turbo-fetch
npm install
```

## Usage

Fetch by tx id:

```bash
node scripts/fetch.mjs --tx_id <TRANSACTION_ID> --output_path ./downloaded.bin
```

Fetch by tags:

```bash
node scripts/fetch.mjs \
  --app_tag codex-arweave-skill \
  --hash <SHA256_HEX> \
  --owner_address <OPTIONAL_ADDRESS>
```

Arguments:
- `--tx_id` direct lookup
- `--owner_address` optional owner filter for tag query
- `--app_tag` tag lookup namespace
- `--hash` value for `Content-SHA256`
- `--name` value for `Logical-Name`
- `--created_at` value for `Created-At`
- `--tags` extra JSON tags for query
- `--expected_hash` explicit integrity hash
- `--content_encoding` force decoding (`gzip`, `br`)
- `--output_path` write decoded content
- `--env_file` path to `.env`

## Behavior Contract

1. Resolves tx id directly or via GraphQL tag query.
2. Downloads with retry + gateway fallback.
3. Decodes based on encoding tag or explicit argument.
4. Computes integrity checks and emits structured JSON with:
- `found`
- `tx_id`
- `bytes`
- `saved_to`
- `integrity_check`

## Safety Rules

- Never print secret env values.
- Treat tag-index misses as eventually consistent; return `found: false` cleanly.
