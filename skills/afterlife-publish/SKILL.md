---
name: afterlife-publish
description: Publish and evolve ar//afterlife entities (Idea -> SelfSnapshot -> SelfHead) with required Afterlife tags so Explore indexing works.
---

# Afterlife Publish

Use this skill for any Afterlife publishing/evolution flow.

## What It Enforces

- Required namespace tags for discoverability:
  - `App-Name=ar//afterlife`
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
- `--save_script` optional path to `arweave-turbo-save/scripts/save.mjs`
- `--env_file` optional env path for turbo save
- `--dry_run` `true|false` (default `false`)
- `--verify` `true|false` (default `true`)
- `--verify_attempts` (default `8`)
- `--verify_delay_ms` (default `1500`)

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
