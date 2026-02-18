import { fetchTxJson, getLatestSelfHead, getGateways } from "../lib/arweave";
import { inferSelfNameFromTags, parseSelfHead, parseSelfSnapshot } from "../lib/schema";

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

function txLink(txId: string): string {
  const gw = getGateways()[0];
  return `${gw.replace(/\/$/, "")}/${txId}`;
}

function getSelfId(): string | null {
  const u = new URL(window.location.href);
  return u.searchParams.get("id");
}

async function loadSelf(): Promise<void> {
  const status = el<HTMLDivElement>("status");
  const content = el<HTMLDivElement>("content");
  content.innerHTML = "";

  const selfId = getSelfId();
  if (!selfId) {
    status.innerHTML =
      '<span style="color: var(--danger)">Missing self id.</span> Use <code>/self?id=&lt;Self-Id&gt;</code>.';
    return;
  }

  status.textContent = `Resolving latest SelfHead for ${selfId}…`;
  const latest = await getLatestSelfHead(selfId);
  if (!latest) {
    status.innerHTML = `No SelfHead found for <code>${escapeHtml(selfId)}</code>.`;
    return;
  }

  const nameFromTags = inferSelfNameFromTags(latest.tags) ?? "(unnamed)";
  status.textContent = `Fetching head JSON (${latest.id})…`;

  let headJson: unknown;
  try {
    headJson = await fetchTxJson(latest.id);
  } catch (err) {
    status.innerHTML = `<span style="color: var(--danger)">Failed to fetch head JSON.</span> ${escapeHtml(
      (err as Error)?.message ?? String(err),
    )}`;
    return;
  }

  const headParsed = parseSelfHead(headJson);
  const headOk = headParsed.ok ? headParsed.value : null;

  const headerCard = document.createElement("div");
  headerCard.className = "card";
  headerCard.innerHTML = `
    <h2 style="margin:0 0 8px;">${escapeHtml(headOk?.name ?? nameFromTags)}</h2>
    <div class="muted">${escapeHtml(headOk?.description ?? "No description.")}</div>
    <div class="kvs">
      <div class="k">Self-Id</div><div class="v">${escapeHtml(selfId)}</div>
      <div class="k">Head Tx</div><div class="v"><a href="${escapeHtml(txLink(latest.id))}" target="_blank" rel="noreferrer">${escapeHtml(latest.id)}</a></div>
      <div class="k">Owner</div><div class="v">${escapeHtml(latest.owner.address)}</div>
      <div class="k">Snapshot Tx</div><div class="v">${escapeHtml(headOk?.snapshot_tx ?? "(missing)")}</div>
    </div>
    ${headParsed.ok ? "" : `<div class="notice"><strong style="color: var(--danger)">Malformed SelfHead JSON:</strong> ${escapeHtml(headParsed.error)}</div>`}
    <div class="row" style="margin-top:14px;">
      <a class="btn primary" href="/clone?id=${encodeURIComponent(selfId)}">Clone</a>
      <a class="btn" href="/publish">How to publish</a>
    </div>
  `;
  content.appendChild(headerCard);

  if (!headOk?.snapshot_tx) {
    status.textContent = "Done (snapshot missing).";
    return;
  }

  status.textContent = `Fetching snapshot JSON (${headOk.snapshot_tx})…`;
  let snapshotJson: unknown;
  try {
    snapshotJson = await fetchTxJson(headOk.snapshot_tx);
  } catch (err) {
    status.innerHTML = `<span style="color: var(--danger)">Failed to fetch snapshot JSON.</span> ${escapeHtml(
      (err as Error)?.message ?? String(err),
    )}`;
    return;
  }

  const snapParsed = parseSelfSnapshot(snapshotJson);
  const snap = snapParsed.ok ? snapParsed.value : null;

  const snapCard = document.createElement("div");
  snapCard.className = "card";
  snapCard.innerHTML = `
    <h3 style="margin:0 0 10px;">Snapshot</h3>
    ${snap ? `<div class="kvs">
      <div class="k">Ideas</div><div class="v">${snap.ideas.length}</div>
      <div class="k">Edges</div><div class="v">${snap.edges?.length ?? 0}</div>
      <div class="k">Parent</div><div class="v">${escapeHtml(snap.parent_snapshot_tx ?? "(none)")}</div>
      <div class="k">Created</div><div class="v">${escapeHtml(snap.created_at ?? "(unknown)")}</div>
    </div>` : `<div class="notice"><strong style="color: var(--danger)">Malformed SelfSnapshot JSON:</strong> ${escapeHtml(snapParsed.ok ? "" : snapParsed.error)}</div>`}
    <details style="margin-top:12px;">
      <summary class="muted">Show raw snapshot JSON</summary>
      <pre>${escapeHtml(JSON.stringify(snapshotJson, null, 2))}</pre>
    </details>
  `;
  content.appendChild(snapCard);

  status.textContent = "Done.";
}

document.addEventListener("DOMContentLoaded", () => {
  loadSelf().catch((err) => {
    el<HTMLDivElement>("status").innerHTML = `<span style="color: var(--danger)">Error:</span> ${escapeHtml(
      (err as Error)?.message ?? String(err),
    )}`;
  });
});

