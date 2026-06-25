export function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 2)
}

export function termFrequency(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  return counts
}

export function cosineScore(query: Map<string, number>, document: Map<string, number>): number {
  let dot = 0
  let queryNorm = 0
  let documentNorm = 0

  for (const value of query.values()) {
    queryNorm += value * value
  }
  for (const value of document.values()) {
    documentNorm += value * value
  }
  for (const [token, value] of query.entries()) {
    dot += value * (document.get(token) ?? 0)
  }

  if (queryNorm === 0 || documentNorm === 0) return 0
  return dot / Math.sqrt(queryNorm * documentNorm)
}
