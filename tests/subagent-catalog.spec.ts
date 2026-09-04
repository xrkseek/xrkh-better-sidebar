import { describe, expect, it } from "vitest";
import {
  normalizeSubagentCatalog,
  normalizeSubagentCatalogs,
} from "../src/subagent-catalog.ts";
import type { SidebarSubagentCatalog } from "../src/context-types.ts";

describe("normalizeSubagentCatalogs", () => {
  it("returns {} for missing feeds", () => {
    expect(normalizeSubagentCatalogs(undefined)).toEqual({});
    expect(normalizeSubagentCatalogs(null)).toEqual({});
  });

  it("fills missing entries so .length is safe", () => {
    const broken = {
      state: "loading",
      parentAvailable: true,
      error: null,
    } as unknown as SidebarSubagentCatalog;
    expect(normalizeSubagentCatalog(broken)?.entries).toEqual([]);
    const map = normalizeSubagentCatalogs({ p1: broken });
    expect(map.p1?.entries.length).toBe(0);
    expect(map.p1?.state).toBe("loading");
  });

  it("preserves catalogs that already have entries", () => {
    const ready: SidebarSubagentCatalog = {
      state: "ready",
      parentAvailable: true,
      error: null,
      entries: [
        {
          kind: "child",
          id: "c1",
          activity: "inactive",
          hasChildren: false,
          mode: "one-shot",
          label: "child",
        },
      ],
    };
    expect(normalizeSubagentCatalog(ready)).toBe(ready);
  });
});
