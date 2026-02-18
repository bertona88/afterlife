import { listSelfHeadEdges, groupLatestHeadsBySelfId, getGateways } from "../lib/arweave";
import { tagsToMap, tagFirst } from "../lib/tags";

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

function fmtDate(ts: number | null | undefined): string {
  if (!ts) return "unknown";
  return new Date(ts * 1000).toISOString();
}

function txLink(txId: string): string {
  const gw = getGateways()[0];
  return `${gw.replace(/\/$/, "")}/${txId}`;
}

async function loadLatestHeads(): Promise<void> {
  const status = el<HTMLDivElement>("status");
  const list = el<HTMLDivElement>("list");
  list.innerHTML = "";
  status.textContent = "Loading latest SelfHead transactions from Arweave GraphQL…";

  try {
    const { edges } = await listSelfHeadEdges({ first: 200, after: null });
    const heads = groupLatestHeadsBySelfId(edges);
    if (heads.length === 0) {
      status.innerHTML = 'No selfs found yet. <a href="/publish">Publish the first one</a>.';
      return;
    }

    status.textContent = `Showing ${heads.length} selfs (latest head per Self-Id).`;

    for (const head of heads) {
      const tagMap = tagsToMap(head.tags);
      const selfId = tagFirst(tagMap, "Self-Id") ?? "unknown";
      const selfName = tagFirst(tagMap, "Self-Name") ?? "(unnamed)";
      const updatedAt = fmtDate(head.block?.timestamp);

      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <div class="row" style="justify-content: space-between;">
          <div>
            <h3 style="margin:0 0 6px;">${escapeHtml(selfName)}</h3>
            <div class="muted" style="font-size:13px;">Self-Id: <code>${escapeHtml(selfId)}</code></div>
          </div>
          <div class="row">
            <a class="btn" href="/self?id=${encodeURIComponent(selfId)}">Open</a>
            <a class="btn primary" href="/clone?id=${encodeURIComponent(selfId)}">Clone</a>
          </div>
        </div>
        <div class="kvs">
          <div class="k">Owner</div>
          <div class="v">${escapeHtml(head.owner.address)}</div>
          <div class="k">Updated</div>
          <div class="v">${escapeHtml(updatedAt)}</div>
          <div class="k">Head Tx</div>
          <div class="v"><a href="${escapeHtml(txLink(head.id))}" target="_blank" rel="noreferrer">${escapeHtml(head.id)}</a></div>
        </div>
      `;
      list.appendChild(card);
    }
  } catch (err) {
    status.innerHTML = `<span style="color: var(--danger)">Failed to load.</span> ${escapeHtml(
      (err as Error)?.message ?? String(err),
    )}`;
  }
}

function initGatewayOverride(): void {
  const input = el<HTMLInputElement>("gatewayOverride");
  const saveBtn = el<HTMLButtonElement>("saveGateway");
  const clearBtn = el<HTMLButtonElement>("clearGateway");
  const existing = localStorage.getItem("afterlifeGatewayUrl");
  if (existing) input.value = existing;

  saveBtn.addEventListener("click", async () => {
    localStorage.setItem("afterlifeGatewayUrl", input.value.trim());
    await loadLatestHeads();
  });
  clearBtn.addEventListener("click", async () => {
    localStorage.removeItem("afterlifeGatewayUrl");
    input.value = "";
    await loadLatestHeads();
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  initGatewayOverride();
  await loadLatestHeads();
});

