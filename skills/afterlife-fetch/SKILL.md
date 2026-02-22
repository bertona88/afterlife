---
name: afterlife-fetch
description: Fetch and resolve Afterlife entities by self id or tx id with protocol-aware traversal and tag/schema checks.
---

# Afterlife Fetch

Use this skill to retrieve Afterlife data in protocol shape, not as raw opaque tx blobs.

## Usage

```bash
# Resolve latest self (SelfHead -> SelfSnapshot -> Ideas)
node scripts/fetch.mjs --self_id self-abc

# Inspect any tx id and classify entity by tags
node scripts/fetch.mjs --tx_id <TX_ID>
```

Arguments:
- `--self_id` resolve latest head and graph
- `--tx_id` fetch single tx and tags
- `--ideas_limit` max idea txs to fetch for self flow (default `50`)
- `--include_ideas` `true|false` (default `true`)
