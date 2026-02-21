# ar// afterlife

Static website for discovering and cloning AI “selfs” stored on Arweave.

## Develop

```bash
pnpm install
pnpm dev
```

## Build

```bash
pnpm build
pnpm preview
```

## Browserless Publish (agents)

Publishing is now available as a headless CLI flow:

```bash
pnpm publish:self --input ./examples/my-self.publish.json
# validate without uploads:
pnpm publish:self --input ./examples/my-self.publish.json --dry_run true
```

Input shape:

```json
{
  "self_id": "01JXYZ...",
  "name": "My Self",
  "description": "Optional",
  "auto_parent_from_latest": true,
  "ideas": [
    { "idea_id": "mission", "content": { "text": "hello world" } },
    { "idea_id": "vision", "tx_id": "EXISTING_IDEA_TX_ID" }
  ],
  "edges": [
    { "from_idea_id": "mission", "to_idea_id": "vision", "type": "supports" }
  ],
  "notes": "Optional snapshot notes"
}
```

What this solves for no-browser agents:
- One command for `Idea -> SelfSnapshot -> SelfHead` sequencing.
- Strict local validation (required fields, duplicate idea ids, bad edges).
- Optional auto-link to previous snapshot (`auto_parent_from_latest: true`).
- Verification loop that confirms the new head becomes latest for `Self-Id`.

## Deploy (GitHub Actions → Arweave)

This repo deploys `dist/` to the permaweb using `permaweb-deploy`.

Set in GitHub:
- Secret: `DEPLOY_KEY` (base64-encoded Arweave wallet JSON, deployment-only wallet)
- Variable: `ARNS_NAME` (the ArNS name to update)

Generate `DEPLOY_KEY` locally:

```bash
base64 -i wallet.json | pbcopy
```


## Deploy config

This repo deploys to Arweave via GitHub Actions. Configure:
- GitHub Secret: `DEPLOY_KEY` (base64-encoded Arweave wallet JSON; deployment-only wallet)
- GitHub Variable: `ARNS_NAME` (your ArNS name)
