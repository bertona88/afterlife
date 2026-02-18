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
