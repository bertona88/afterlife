---
name: afterlife-verify
description: Verify Afterlife discoverability and protocol integrity for tx ids or full self chains.
---

# Afterlife Verify

Use this skill before/after publish to confirm a self is valid and indexable in Explore.

## Usage

```bash
# Verify full chain by self id
node scripts/verify.mjs --self_id self-abc

# Verify a specific tx
node scripts/verify.mjs --tx_id <TX_ID>
```

## Runtime Notes

- This skill is self-contained; it does not require a separate generic Arweave verification/fetch skill.
- It verifies bundled data items through public gateways and decodes compressed JSON payloads when the tx tags indicate `gzip` or `br`.
- Right after publish, `--tx_id` verification is typically more reliable than `--self_id` because tag-indexed latest-head queries can lag.

Checks:
- Required Afterlife tags
- Entity-specific payload minimums
- Snapshot references and edge integrity
- Discoverability through latest-head GraphQL filter
