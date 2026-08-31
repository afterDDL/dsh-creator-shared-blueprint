/** Canonical JSON serialization for digest and exact-equality evidence. */

/**
 * Serialize JSON-compatible data with recursively sorted object keys.
 * @param value - parsed configuration or typed evidence to serialize.
 * @returns deterministic JSON text independent of object insertion order.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`
  }
  const encoded: unknown = JSON.stringify(value)
  return typeof encoded === 'string' ? encoded : 'null'
}
