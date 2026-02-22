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

Checks:
- Required Afterlife tags
- Entity-specific payload minimums
- Snapshot references and edge integrity
- Discoverability through latest-head GraphQL filter
