export type ArweaveTag = { name: string; value: string };
export type TagMap = Map<string, string[]>;

export function tagsToMap(tags: ArweaveTag[] | null | undefined): TagMap {
  const map: TagMap = new Map();
  if (!tags) return map;
  for (const tag of tags) {
    const existing = map.get(tag.name) ?? [];
    existing.push(tag.value);
    map.set(tag.name, existing);
  }
  return map;
}

export function tagFirst(tags: TagMap, name: string): string | undefined {
  return tags.get(name)?.[0];
}

