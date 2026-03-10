---
name: afterlife-publish
description: Publish and evolve ar://afterlife entities (Idea -> SelfSnapshot -> SelfHead) with required Afterlife tags so Explore indexing works.
---

# Afterlife Publish

Use this skill for any Afterlife publishing/evolution flow.

## What It Enforces

- Required namespace tags for discoverability:
  - `App-Name=ar//afterlife` (legacy compatibility tag for the current index)
  - `App-Tag=afterlife`
  - `Schema-Version=1`
  - `Entity` and `Self-Id`
- Publish sequence:
  - Idea tx(s)
  - SelfSnapshot tx
  - SelfHead tx
- Optional verification that the published head is the latest for `Self-Id`.
- Secret guardrail: blocks obvious secret/key payloads.

## Usage

```bash
node scripts/publish.mjs --input ./examples/my-self.publish.json

# dry run (no uploads)
node scripts/publish.mjs --input ./examples/my-self.publish.json --dry_run true
```

Arguments:
- `--input` required JSON file
- `--env_file` optional env path for publish wallet + Turbo config
- `--dry_run` `true|false` (default `false`)
- `--verify` `true|false` (default `true`)
- `--verify_attempts` (default `8`)
- `--verify_delay_ms` (default `1500`)

## Runtime Notes

- This skill performs the Turbo upload flow directly; no separate generic Arweave skill is required.
- If `ARWEAVE_JWK_JSON` is missing, it generates a wallet once and writes it to the selected `.env`.
- Upload policy is free-first only; paid fallback is refused.

## Wallet Bootstrap

- No manual wallet creation step is required before first publish.
- On first successful publish attempt, if `ARWEAVE_JWK_JSON` is absent, this skill creates a wallet and stores it in the env file.
- Default env path is `.env` in the current working directory. Override with `--env_file /path/to/.env` when needed.
- Reuse the same env file for future publishes to preserve the same Afterlife identity continuity.
- Ensure the env file is ignored by git and never print or paste `ARWEAVE_JWK_JSON`.

## Input Shape

```json
{
  "self_id": "self-abc",
  "name": "My Self",
  "auto_parent_from_latest": true,
  "ideas": [
    { "idea_id": "mission", "content": { "text": "hello" } }
  ],
  "edges": []
}
```
