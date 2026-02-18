import type { ArweaveTag } from "./tags";
import { tagsToMap, tagFirst } from "./tags";

export type SnapshotEdgeType =
  | "supports"
  | "contradicts"
  | "refines"
  | "depends-on"
  | "derived-from";

export type SelfHead = {
  schema: "afterlife.selfhead@1";
  self_id: string;
  name: string;
  description?: string;
  snapshot_tx: string;
  fork_of?: { source_self_id: string; source_head_tx: string };
  owner_address?: string;
  updated_at?: string;
  links?: { repo?: string; homepage?: string };
};

export type SelfSnapshot = {
  schema: "afterlife.snapshot@1";
  self_id: string;
  parent_snapshot_tx?: string | null;
  ideas: Array<{ idea_id: string; tx_id: string }>;
  edges?: Array<{
    from_idea_id: string;
    to_idea_id: string;
    type: SnapshotEdgeType;
  }>;
  notes?: string;
  created_at?: string;
};

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

export function parseSelfHead(json: unknown): ParseResult<SelfHead> {
  if (!isRecord(json)) return { ok: false, error: "SelfHead is not an object" };
  const schema = getString(json, "schema");
  if (schema !== "afterlife.selfhead@1") {
    return { ok: false, error: `Unexpected SelfHead schema: ${schema ?? "missing"}` };
  }

  const self_id = getString(json, "self_id");
  const name = getString(json, "name");
  const snapshot_tx = getString(json, "snapshot_tx");
  if (!self_id) return { ok: false, error: "SelfHead.self_id missing" };
  if (!name) return { ok: false, error: "SelfHead.name missing" };
  if (!snapshot_tx) return { ok: false, error: "SelfHead.snapshot_tx missing" };

  const description = getString(json, "description");
  const owner_address = getString(json, "owner_address");
  const updated_at = getString(json, "updated_at");

  let fork_of: SelfHead["fork_of"];
  const forkObj = json["fork_of"];
  if (isRecord(forkObj)) {
    const source_self_id = getString(forkObj, "source_self_id");
    const source_head_tx = getString(forkObj, "source_head_tx");
    if (source_self_id && source_head_tx) fork_of = { source_self_id, source_head_tx };
  }

  let links: SelfHead["links"];
  const linksObj = json["links"];
  if (isRecord(linksObj)) {
    const repo = getString(linksObj, "repo");
    const homepage = getString(linksObj, "homepage");
    if (repo || homepage) links = { repo, homepage };
  }

  return {
    ok: true,
    value: {
      schema: "afterlife.selfhead@1",
      self_id,
      name,
      snapshot_tx,
      description,
      fork_of,
      owner_address,
      updated_at,
      links,
    },
  };
}

export function parseSelfSnapshot(json: unknown): ParseResult<SelfSnapshot> {
  if (!isRecord(json)) return { ok: false, error: "SelfSnapshot is not an object" };
  const schema = getString(json, "schema");
  if (schema !== "afterlife.snapshot@1") {
    return { ok: false, error: `Unexpected SelfSnapshot schema: ${schema ?? "missing"}` };
  }
  const self_id = getString(json, "self_id");
  if (!self_id) return { ok: false, error: "SelfSnapshot.self_id missing" };

  const ideasRaw = json["ideas"];
  if (!Array.isArray(ideasRaw)) return { ok: false, error: "SelfSnapshot.ideas missing" };
  const ideas: SelfSnapshot["ideas"] = [];
  for (const idea of ideasRaw) {
    if (!isRecord(idea)) continue;
    const idea_id = getString(idea, "idea_id");
    const tx_id = getString(idea, "tx_id");
    if (idea_id && tx_id) ideas.push({ idea_id, tx_id });
  }
  if (ideas.length === 0) return { ok: false, error: "SelfSnapshot.ideas empty/invalid" };

  const edgesRaw = json["edges"];
  let edges: SelfSnapshot["edges"];
  if (Array.isArray(edgesRaw)) {
    const allowed = new Set<SnapshotEdgeType>([
      "supports",
      "contradicts",
      "refines",
      "depends-on",
      "derived-from",
    ]);
    const parsed: NonNullable<SelfSnapshot["edges"]> = [];
    for (const edge of edgesRaw) {
      if (!isRecord(edge)) continue;
      const from_idea_id = getString(edge, "from_idea_id");
      const to_idea_id = getString(edge, "to_idea_id");
      const typeRaw = getString(edge, "type");
      if (!from_idea_id || !to_idea_id || !typeRaw) continue;
      if (!allowed.has(typeRaw as SnapshotEdgeType)) continue;
      parsed.push({ from_idea_id, to_idea_id, type: typeRaw as SnapshotEdgeType });
    }
    edges = parsed;
  }

  const parent_snapshot_tx = getString(json, "parent_snapshot_tx") ?? null;
  const notes = getString(json, "notes");
  const created_at = getString(json, "created_at");

  return {
    ok: true,
    value: {
      schema: "afterlife.snapshot@1",
      self_id,
      parent_snapshot_tx,
      ideas,
      edges,
      notes,
      created_at,
    },
  };
}

export function inferSelfNameFromTags(tags: ArweaveTag[] | null | undefined): string | undefined {
  const map = tagsToMap(tags);
  return tagFirst(map, "Self-Name");
}

