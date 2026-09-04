/**
 * Label prefix for Side Chat-shaped subagent children (legacy).
 * Kept so Subagent / live topology can filter old "Side: …" threads after
 * the Side Chat (beta) tab was removed.
 */
export const SIDE_LABEL_PREFIX = "Side: " as const;

export function isSideThreadLabel(label: string | undefined | null): boolean {
  return typeof label === "string" && label.startsWith(SIDE_LABEL_PREFIX);
}
