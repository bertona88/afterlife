import { fetchTxJson, getLatestSelfHead } from "../lib/arweave";
import { inferSelfNameFromTags, parseSelfHead } from "../lib/schema";
import { newUlid } from "../lib/ulid";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return c;
    }
  });
}

function getSelfId(): string | null {
  const u = new URL(window.location.href);
  return u.searchParams.get("id");
}

function downloadJson(filename: string, obj: unknown): void {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function loadClone(): Promise<void> {
  const status = el<HTMLDivElement>("status");
  const templatePre = el<HTMLPreElement>("template");
  const downloadBtn = el<HTMLButtonElement>("download");
  const cmdPre = el<HTMLPreElement>("commands");

  const selfId = getSelfId();
  if (!selfId) {
    status.innerHTML =
      '<span style="color: var(--danger)">Missing self id.</span> Use <code>/clone?id=&lt;Self-Id&gt;</code>.';
    return;
  }

  status.textContent = `Resolving latest SelfHead for ${selfId}…`;
  const latest = await getLatestSelfHead(selfId);
  if (!latest) {
    status.innerHTML = `No SelfHead found for <code>${escapeHtml(selfId)}</code>.`;
    return;
  }

  let headJson: unknown;
  try {
    headJson = await fetchTxJson(latest.id);
  } catch (err) {
    status.innerHTML = `<span style="color: var(--danger)">Failed to fetch head JSON.</span> ${escapeHtml(
      (err as Error)?.message ?? String(err),
    )}`;
    return;
  }

  const parsed = parseSelfHead(headJson);
  const head = parsed.ok ? parsed.value : null;
  const sourceName = head?.name ?? inferSelfNameFromTags(latest.tags) ?? "(unnamed)";

  const newSelfId = newUlid();
  const template = {
    schema: "afterlife.clone-template@1",
    new_self_id: newSelfId,
    name: `${sourceName} (fork)`,
    description: `Forked from ${sourceName} (${selfId}).`,
    fork_of: { source_self_id: selfId, source_head_tx: latest.id },
    initial_snapshot_tx: head?.snapshot_tx ?? null,
  };

  templatePre.textContent = JSON.stringify(template, null, 2);
  downloadBtn.onclick = () => downloadJson(`self-${newSelfId}.json`, template);

  cmdPre.textContent = [
    "# (Optional) fetch the source head JSON for inspection",
    "node /Users/andreabertoncini/.codex/skills/arweave-turbo-fetch/scripts/fetch.mjs \\",
    `  --tx_id ${latest.id} --output_path ./source.selfhead.json`,
    "",
    "# Publish your fork (example): upload a new SelfHead JSON file with Afterlife tags",
    "# IMPORTANT: keep your agent's .env safe — it contains ARWEAVE_JWK_JSON (your identity).",
    "node /Users/andreabertoncini/.codex/skills/arweave-turbo-save/scripts/save.mjs \\",
    "  --file_path ./my.selfhead.json \\",
    "  --content_type application/json \\",
    "  --tags '{\"App-Name\":\"ar//afterlife\",\"App-Tag\":\"afterlife\",\"Schema-Version\":\"1\",\"Entity\":\"SelfHead\",\"Self-Id\":\"<NEW_SELF_ID>\",\"Self-Name\":\"<DISPLAY_NAME>\"}' \\",
    "  --mode auto --compress_if_needed true",
  ].join("\n");

  status.textContent = "Ready. Download your fork template, then publish from your agent runtime.";
}

document.addEventListener("DOMContentLoaded", () => {
  loadClone().catch((err) => {
    el<HTMLDivElement>("status").innerHTML = `<span style="color: var(--danger)">Error:</span> ${escapeHtml(
      (err as Error)?.message ?? String(err),
    )}`;
  });
});
