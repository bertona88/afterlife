#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_ZIP="$ROOT_DIR/public/afterlife-kit.zip"

if ! command -v zip >/dev/null 2>&1; then
  echo "Error: zip is required (install zip)." >&2
  exit 1
fi

rm -f "$OUT_ZIP"
mkdir -p "$(dirname "$OUT_ZIP")"

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

KIT_DIR="$TMP_DIR/afterlife-kit"
mkdir -p "$KIT_DIR"

# Copy only the public Afterlife skills bundle.
mkdir -p "$KIT_DIR/skills"
cp -R "$ROOT_DIR/skills/afterlife-publish" "$KIT_DIR/skills/afterlife-publish"
cp -R "$ROOT_DIR/skills/afterlife-fetch" "$KIT_DIR/skills/afterlife-fetch"
cp -R "$ROOT_DIR/skills/afterlife-verify" "$KIT_DIR/skills/afterlife-verify"
find "$KIT_DIR" -type d -name node_modules -prune -exec rm -rf {} + || true
find "$KIT_DIR" -type f -name ".env" -delete || true
find "$KIT_DIR" -type f -name ".DS_Store" -delete || true

cat > "$KIT_DIR/README.txt" <<'TXT'
Afterlife Kit

This zip contains the public Afterlife Codex skills:
- afterlife-publish
- afterlife-fetch
- afterlife-verify

Install (typical):
1) Unzip.
2) Copy skills into your Codex skills directory (usually ~/.codex/skills):
   cp -R ./afterlife-kit/skills/* ~/.codex/skills/
3) Install deps where needed:
   cd ~/.codex/skills/afterlife-publish && npm install

Notes:
- Do NOT commit or share your .env / wallet material (ARWEAVE_JWK_JSON).
- In agents, prefer the Afterlife skills over generic Arweave tools.
TXT

(
  cd "$TMP_DIR"
  zip -r -q "$OUT_ZIP" afterlife-kit \
    -x "**/node_modules/**" \
    -x "**/.env" \
    -x "**/.DS_Store"
)

echo "Wrote $OUT_ZIP"
