// Human-readable numbering within one research task (frontend plan F3).
// Numbers follow creation order and never change once assigned, because rows
// are never deleted (failed and canceled runs stay in the history).

type Numbered = { id: string; createdAt: string };

function ordered<T extends Numbered>(items: readonly T[]) {
  return [...items].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 1-based position of `id` among `items` by creation time, or null. */
export function sequenceNumber(items: readonly Numbered[], id: string): number | null {
  const index = ordered(items).findIndex((item) => item.id === id);
  return index < 0 ? null : index + 1;
}

/** Map of id → 1-based number for a list. */
export function sequenceNumbers(items: readonly Numbered[]): Map<string, number> {
  return new Map(ordered(items).map((item, index) => [item.id, index + 1]));
}

export const runLabel = (number: number | null) => (number ? `运行 #${number}` : "运行");
export const attemptLabel = (number: number | null) => (number ? `代理 #${number}` : "代理");
