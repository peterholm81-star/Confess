// In-memory session cache for resolved places
// Does not persist across page reloads

export type ResolvedPlace = {
  query: string
  name: string
  lat: number
  lng: number
}

const cache = new Map<string, ResolvedPlace>()

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase()
}

export function getCachedPlace(query: string): ResolvedPlace | null {
  const key = normalizeQuery(query)
  const result = cache.get(key) || null
  console.log('[cache]', key, result ? 'HIT' : 'MISS')
  return result
}

export function setCachedPlace(place: ResolvedPlace): void {
  const key = normalizeQuery(place.query)
  cache.set(key, place)
}

export function getRandomFromList<T>(list: T[]): T | null {
  if (list.length === 0) return null
  return list[Math.floor(Math.random() * list.length)]
}
