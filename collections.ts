// groups items by a key, keeping each group in the items' original order and
// the groups in first-seen order. One pass, no per-item allocation beyond
// the group arrays — used on full years of period lines, so it has to stay
// cheap.
export function groupBy<T>(
  items: Iterable<T>,
  keyOf: (item: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const group = groups.get(key)
    if (group) {
      group.push(item)
    } else {
      groups.set(key, [item])
    }
  }
  return groups
}

// total of value(item) over the items matching keep — e.g. a student's
// absence minutes for one rule.
export function sumWhere<T>(
  items: Iterable<T>,
  keep: (item: T) => boolean,
  value: (item: T) => number,
): number {
  let total = 0
  for (const item of items) {
    if (keep(item)) {
      total += value(item)
    }
  }
  return total
}
