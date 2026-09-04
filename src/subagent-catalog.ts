/**
 * Normalize Host-delivered subagent catalogs so the client never reads
 * `undefined.entries` (crash: Cannot read properties of undefined (reading 'length')).
 */
import type { SidebarSubagentCatalog } from "./context-types.ts";

const EMPTY_ENTRIES: SidebarSubagentCatalog["entries"] = [];

/** Ensure one catalog always has an array `entries` field. */
export function normalizeSubagentCatalog(
  catalog: SidebarSubagentCatalog | null | undefined,
): SidebarSubagentCatalog | undefined {
  if (catalog == null) return undefined;
  if (Array.isArray(catalog.entries)) return catalog;
  return {
    ...catalog,
    entries: EMPTY_ENTRIES,
  };
}

/**
 * Normalize the per-parent catalog map from `sessions.list`.
 * Missing / non-object feeds become `{}`.
 */
export function normalizeSubagentCatalogs(
  byParent:
    | Readonly<Record<string, SidebarSubagentCatalog>>
    | null
    | undefined,
): Readonly<Record<string, SidebarSubagentCatalog>> {
  if (byParent == null || typeof byParent !== "object") return {};
  const out: Record<string, SidebarSubagentCatalog> = {};
  for (const [id, catalog] of Object.entries(byParent)) {
    const normalized = normalizeSubagentCatalog(catalog);
    if (normalized !== undefined) out[id] = normalized;
  }
  return out;
}
