// Small helpers for catalog entries that include values.

/** "1 person", "3 people": n with the right form of the word. */
export const plural = (n: number, one: string, other: string): string => `${n} ${n === 1 ? one : other}`;

/** "A", "A and B", "A, B and C". */
export function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
