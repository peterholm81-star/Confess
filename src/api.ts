import { supabase } from './supabase'
import type { Confession } from './supabase'

// Dev-only logging
const DEV = import.meta.env.DEV

// =============================================================================
// UNIFIED FEED API
// =============================================================================
// Single function for all feed modes (world / near)
// Uses RPC: get_confess_feed
// 
// Pagination: keyset-based using (created_at, id) cursor
// - Pass cursor from previous response to get next page
// - hasMore indicates if more items exist
// 
// The RPC handles:
// - Expiry filtering (expires_at > now())
// - Moderation filtering (is_hidden = false)
// - Distance calculation for 'near' mode
// =============================================================================

const DEFAULT_LIMIT = 30

export type FeedMode = 'world' | 'near'

export type PageCursor = {
  created_at: string
  id: string
} | null

export type FeedResult = {
  confessions: Confession[]
  nextCursor: PageCursor
  hasMore: boolean
}

export type FetchFeedParams = {
  mode: FeedMode
  cursor?: PageCursor
  limit?: number
  lat?: number
  lng?: number
  radiusM?: number
}

/**
 * FEED CONTRACT
 * =============
 * Single entry point for all feed fetching. Uses RPC: get_confess_feed
 * 
 * Modes:
 *   - 'world': All confessions (no location filter)
 *   - 'near': Location-based (requires lat/lng, uses radiusM)
 * 
 * Pagination:
 *   - Keyset cursor: { created_at: string, id: string }
 *   - Pass cursor from previous response to get next page
 *   - Limit clamped to [10, 50], default 30
 * 
 * Server-side filters (always applied):
 *   - expires_at > now() (only unexpired confessions)
 *   - is_hidden = false (moderation)
 * 
 * @param params.mode - 'world' or 'near'
 * @param params.cursor - Pagination cursor from previous response
 * @param params.limit - Page size (default 30, clamped to max 50)
 * @param params.lat - Latitude (required for 'near' mode)
 * @param params.lng - Longitude (required for 'near' mode)
 * @param params.radiusM - Search radius in meters (default 1000)
 */
export async function fetchFeed(params: FetchFeedParams): Promise<FeedResult> {
  const { mode, cursor, limit = DEFAULT_LIMIT, lat, lng, radiusM = 1000 } = params
  
  if (!supabase) {
    if (DEV) console.warn('[fetchFeed] supabase not configured')
    return { confessions: [], nextCursor: null, hasMore: false }
  }

  // Validate near mode params
  if (mode === 'near' && (lat == null || lng == null)) {
    if (DEV) console.warn('[fetchFeed] near mode requires lat/lng')
    return { confessions: [], nextCursor: null, hasMore: false }
  }

  // Request one extra to determine hasMore
  const requestLimit = Math.min(limit, 50) + 1

  // Build explicit RPC params with undefined -> null conversion
  const rpcParams = {
    p_mode: mode,
    p_limit: requestLimit,
    p_cursor_created_at: cursor?.created_at ?? null,
    p_cursor_id: cursor?.id ?? null,
    p_lat: lat ?? null,
    p_lng: lng ?? null,
    p_radius_m: radiusM ?? 1000,
  }

  try {
    const { data, error } = await supabase.rpc('get_confess_feed', rpcParams)

    if (error) {
      if (DEV) console.warn('[fetchFeed] RPC error:', error.message)
      return { confessions: [], nextCursor: null, hasMore: false }
    }

    const items = data || []
    const hasMore = items.length > limit
    const confessions = hasMore ? items.slice(0, limit) : items

    // Derive next cursor from last item
    const nextCursor: PageCursor = confessions.length > 0
      ? {
          created_at: confessions[confessions.length - 1].created_at,
          id: confessions[confessions.length - 1].id,
        }
      : null

    if (DEV) console.log(`[fetchFeed] ${mode}: ${confessions.length} items, hasMore=${hasMore}`)
    return { confessions, nextCursor, hasMore }
  } catch (err) {
    if (DEV) console.error('[fetchFeed] exception:', err)
    return { confessions: [], nextCursor: null, hasMore: false }
  }
}

// =============================================================================
// INSERT CONFESSION
// =============================================================================
// Uses RPC: insert_confession
// Server handles: validation, expires_at, is_hidden, rate limiting, content filter
// 
// Content filter blocks:
// - @ characters (emails, social handles)
// - URLs and TLDs (.com, .net, etc.)
// - Phone numbers (8+ digits, +country codes)
// - Two capitalized words (likely real names)
// =============================================================================

export type InsertConfessionParams = {
  text: string
  placeLabel?: string
  lat?: number
  lng?: number
}

export type InsertConfessionResult = 
  | { ok: true; confession: Confession }
  | { ok: false; error: 'EMPTY_TEXT' | 'TEXT_TOO_LONG' | 'RATE_LIMIT' | 'CONTENT_BLOCKED' | 'ERROR'; message: string }

/**
 * Insert a new confession via server RPC
 * Server sets expires_at and is_hidden, enforces rate limiting
 */
export async function insertConfession(params: InsertConfessionParams): Promise<InsertConfessionResult> {
  const { text, placeLabel, lat, lng } = params
  
  if (!supabase) {
    return { ok: false, error: 'ERROR', message: 'Not configured' }
  }

  // Build explicit RPC params with undefined -> null conversion
  const rpcParams = {
    p_text: text ?? null,
    p_place_label: placeLabel ?? null,
    p_lat: lat ?? null,
    p_lng: lng ?? null,
  }

  try {
    const { data, error } = await supabase.rpc('insert_confession', rpcParams)

    if (error) {
      // Parse error message to determine type
      const msg = error.message || ''
      
      if (msg.includes('EMPTY_TEXT')) {
        return { ok: false, error: 'EMPTY_TEXT', message: 'Write something first.' }
      }
      if (msg.includes('TEXT_TOO_LONG')) {
        return { ok: false, error: 'TEXT_TOO_LONG', message: 'Keep it under 120 characters.' }
      }
      if (msg.includes('CONTENT_BLOCKED')) {
        return { ok: false, error: 'CONTENT_BLOCKED', message: 'This can\'t be shared.\nAvoid names, contact details, or anything that could identify someone.' }
      }
      if (msg.includes('RATE_LIMIT')) {
        return { ok: false, error: 'RATE_LIMIT', message: 'Slow down — try again in a few seconds.' }
      }
      
      if (DEV) console.error('[insertConfession] RPC error:', msg)
      return { ok: false, error: 'ERROR', message: 'Could not save confession' }
    }

    // RPC returns array with single row
    const row = Array.isArray(data) && data.length > 0 ? data[0] : data
    
    if (!row || !row.id) {
      if (DEV) console.error('[insertConfession] No row returned')
      return { ok: false, error: 'ERROR', message: 'Could not save confession' }
    }

    if (DEV) console.log('[insertConfession] success:', row.id)
    return { 
      ok: true, 
      confession: {
        id: row.id,
        text: row.text,
        created_at: row.created_at,
        expires_at: row.expires_at,
        lat: row.lat,
        lng: row.lng,
      }
    }
  } catch (err) {
    if (DEV) console.error('[insertConfession] exception:', err)
    return { ok: false, error: 'ERROR', message: 'Could not save confession' }
  }
}

// Fetch popular places from places_cache table
export type CachedPlace = {
  id: string
  name: string
  lat: number
  lng: number
}

export async function fetchPopularPlaces(): Promise<CachedPlace[]> {
  if (!supabase) return []

  const { data, error } = await supabase
    .from('places_cache')
    .select('id, name, lat, lng')
    .limit(10)

  if (error) {
    if (DEV) console.warn('[api] fetchPopularPlaces error:', error.message)
    return []
  }

  return data || []
}

// Structured result from resolvePlace
export type ResolvePlaceResult =
  | { ok: true; place: { name: string; lat: number; lng: number } }
  | { ok: false; reason: 'NOT_FOUND' }
  | { ok: false; reason: 'ERROR'; message?: string }

// Detect if error is a 404 (NOT_FOUND) - robust inspection
function is404Error(error: unknown): { is404: boolean; source: string } {
  const errAny = error as Record<string, unknown>
  
  // Check error.status
  if (errAny?.status === 404) {
    return { is404: true, source: 'status' }
  }
  
  // Check error.context.status
  const ctx = errAny?.context as Record<string, unknown> | undefined
  if (ctx?.status === 404) {
    return { is404: true, source: 'context.status' }
  }
  
  // Check error.context.response.status
  const ctxRes = ctx?.response as Record<string, unknown> | undefined
  if (ctxRes?.status === 404) {
    return { is404: true, source: 'context.response.status' }
  }
  
  // Fallback: stringify and search for 404 patterns
  try {
    const str = JSON.stringify(error)
    if (str.includes('"status":404') || str.includes('"status": 404')) {
      return { is404: true, source: 'stringified' }
    }
  } catch {
    // Ignore stringify errors
  }
  
  // Check error message as last resort
  const msg = (errAny?.message as string)?.toLowerCase() || ''
  if (msg.includes('404') || msg.includes('not found')) {
    return { is404: true, source: 'message' }
  }
  
  return { is404: false, source: '' }
}

// Call edge function to resolve a place query
export async function resolvePlace(query: string): Promise<ResolvePlaceResult> {
  if (DEV) console.log('[resolvePlace] start:', query)
  
  if (!supabase) {
    if (DEV) console.error('[resolvePlace] supabase is null')
    return { ok: false, reason: 'ERROR', message: 'Not configured' }
  }

  try {
    const { data, error } = await supabase.functions.invoke('resolve_place', {
      body: { q: query },
    })

    if (DEV) console.log('[resolvePlace] response:', { data, error })

    // Handle Supabase invoke error
    if (error) {
      // Check if it's a 404 (NOT_FOUND)
      const { is404, source } = is404Error(error)
      if (is404) {
        if (DEV) console.log(`[resolvePlace] NOT_FOUND (status 404 via ${source})`)
        return { ok: false, reason: 'NOT_FOUND' }
      }
      // Genuine error (network, 5xx, etc)
      if (DEV) console.error('[resolvePlace] invoke error:', error.message)
      return { ok: false, reason: 'ERROR', message: error.message }
    }

    // Check for NOT_FOUND response from edge function (200 with ok:false)
    if (data?.ok === false && data?.reason === 'NOT_FOUND') {
      if (DEV) console.log('[resolvePlace] NOT_FOUND (from response body)')
      return { ok: false, reason: 'NOT_FOUND' }
    }

    // Check for error field (legacy/other errors)
    if (data?.error) {
      const dataErr = String(data.error).toLowerCase()
      if (dataErr.includes('not found') || dataErr.includes('no results')) {
        if (DEV) console.log('[resolvePlace] NOT_FOUND (from data.error)')
        return { ok: false, reason: 'NOT_FOUND' }
      }
      if (DEV) console.error('[resolvePlace] edge error:', data.error)
      return { ok: false, reason: 'ERROR', message: data.error }
    }

    // Validate success response has coordinates
    if (!data || typeof data.lat !== 'number' || typeof data.lng !== 'number') {
      if (DEV) console.log('[resolvePlace] NOT_FOUND (missing coords)')
      return { ok: false, reason: 'NOT_FOUND' }
    }

    if (DEV) console.log('[resolvePlace] success:', data.name, data.lat, data.lng)
    return { ok: true, place: { lat: data.lat, lng: data.lng, name: data.name || query } }
  } catch (err) {
    // Check if caught exception is a 404
    const { is404, source } = is404Error(err)
    if (is404) {
      if (DEV) console.log(`[resolvePlace] NOT_FOUND (exception 404 via ${source})`)
      return { ok: false, reason: 'NOT_FOUND' }
    }
    if (DEV) console.error('[resolvePlace] exception:', err)
    return { ok: false, reason: 'ERROR', message: 'Network error' }
  }
}
