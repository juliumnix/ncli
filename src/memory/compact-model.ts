import { Cursor, type ModelListItem } from "@cursor/sdk";
import { compactSdkKey } from "../secrets";

export type CompactCatalogModel = Pick<ModelListItem, "id" | "aliases" | "parameters">;

export type CompactModelChoice = {
  id: string;
  params: Array<{ id: string; value: string }>;
};

export type CompactModelLister = (apiKey: string) => Promise<CompactCatalogModel[]>;

const EFFORT_ID = /effort|reason/i;
const THINKING_ID = /^thinking$|^think$/i;
const LOW = /^(low|lowest|minimal|min)$/i;
const OFF = /^(false|off|none|disabled|0)$/i;
const SUFFIX = /-(low|medium|high|fast|max)$/i;

export function unknownCompactModelMessage(requested: string, ids: string[]): string {
  const sample = ids.slice(0, 12).join(", ");
  return [
    `Cannot use this model: ${requested}.`,
    "Cursor SDK model ids have no effort suffix.",
    sample ? `Valid ids include: ${sample}.` : "Cursor.models.list() returned no models for this key.",
    "Set NCLI_COMPACT_MODEL to a catalog id (default claude-haiku-5-5).",
  ].join(" ");
}

export function cheapParamValue(param: {
  id: string;
  values: Array<{ value: string }>;
}): string | undefined {
  const values = param.values.map((v) => v.value);
  if (EFFORT_ID.test(param.id)) return values.find((v) => LOW.test(v));
  if (THINKING_ID.test(param.id)) return values.find((v) => OFF.test(v));
  return undefined;
}

export function resolveCompactModel(catalog: CompactCatalogModel[], requested: string): CompactModelChoice {
  const hit = findCatalogModel(catalog, requested);
  if (!hit) {
    throw new Error(unknownCompactModelMessage(requested, catalog.map((m) => m.id)));
  }
  const params: CompactModelChoice["params"] = [];
  for (const param of hit.parameters ?? []) {
    const value = cheapParamValue(param);
    if (value) params.push({ id: param.id, value });
  }
  return { id: hit.id, params };
}

function findCatalogModel(catalog: CompactCatalogModel[], requested: string): CompactCatalogModel | undefined {
  const ids = [requested, requested.replace(SUFFIX, "")];
  for (const id of ids) {
    const hit = catalog.find((m) => m.id === id || m.aliases?.includes(id));
    if (hit) return hit;
  }
  return undefined;
}

export async function listCompactCatalog(
  apiKey: string,
  list: CompactModelLister = defaultCompactModelLister,
): Promise<CompactCatalogModel[]> {
  return list(apiKey);
}

async function defaultCompactModelLister(apiKey: string): Promise<CompactCatalogModel[]> {
  return Cursor.models.list({ apiKey });
}

export async function assertCompactModel(
  requested: string,
  env: Record<string, string | undefined> = process.env,
  list?: CompactModelLister,
): Promise<CompactModelChoice | undefined> {
  const key = compactSdkKey(env);
  if (!key) return undefined;
  const catalog = await listCompactCatalog(key, list);
  return resolveCompactModel(catalog, requested);
}
