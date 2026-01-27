// Edge function: resolve_place
// Geocodes a place query using Nominatim with DB caching
//
// Expected request: POST with body { q: "city name" }
// Expected response: { lat: number, lng: number, name: string, source: string }
//
// Deploy with: supabase functions deploy resolve_place

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Standard CORS headers for Supabase Edge Functions
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  })
}

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase()
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    })
  }

  try {
    // Parse request body
    let body: { q?: string }
    try {
      body = await req.json()
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400)
    }

    const { q } = body

    // Validate input
    if (!q || typeof q !== 'string') {
      return jsonResponse({ error: 'Missing query parameter q' }, 400)
    }

    const trimmed = q.trim()
    if (trimmed.length < 2) {
      return jsonResponse({ error: 'Query too short (min 2 characters)' }, 400)
    }
    if (trimmed.length > 80) {
      return jsonResponse({ error: 'Query too long (max 80 characters)' }, 400)
    }

    const qLower = normalizeQuery(trimmed)

    // Initialize Supabase client with service role
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('[resolve_place] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
      return jsonResponse({ error: 'Server configuration error' }, 500)
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Check cache first
    const { data: cached, error: cacheError } = await supabase
      .from('place_cache')
      .select('lat, lng, name, provider')
      .eq('q_lower', qLower)
      .single()

    if (cached && !cacheError) {
      console.log(`[resolve_place] Cache hit for: ${qLower}`)
      return jsonResponse({
        ok: true,
        lat: cached.lat,
        lng: cached.lng,
        name: cached.name,
        source: 'cache',
      })
    }

    // Call Nominatim
    const userAgent = Deno.env.get('NOMINATIM_USER_AGENT') || 'Confess/1.0 (anonymous confession app)'
    const nominatimUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(trimmed)}&format=json&limit=1&addressdetails=1`

    console.log(`[resolve_place] Calling Nominatim for: ${trimmed}`)

    let nominatimRes: Response
    try {
      nominatimRes = await fetch(nominatimUrl, {
        headers: {
          'User-Agent': userAgent,
          'Accept': 'application/json',
        },
      })
    } catch (fetchErr) {
      console.error('[resolve_place] Nominatim fetch error:', fetchErr)
      return jsonResponse({ error: 'Geocoding provider error' }, 502)
    }

    if (!nominatimRes.ok) {
      console.error(`[resolve_place] Nominatim returned status ${nominatimRes.status}`)
      return jsonResponse({ error: 'Geocoding provider error' }, 502)
    }

    let nominatimData: Array<{ lat: string; lon: string; display_name: string }>
    try {
      nominatimData = await nominatimRes.json()
    } catch {
      console.error('[resolve_place] Failed to parse Nominatim response')
      return jsonResponse({ error: 'Geocoding provider error' }, 502)
    }

    if (!Array.isArray(nominatimData) || nominatimData.length === 0) {
      console.log(`[resolve_place] NOT_FOUND: ${trimmed}`)
      return jsonResponse({ ok: false, reason: 'NOT_FOUND' }, 200)
    }

    const result = nominatimData[0]
    const lat = parseFloat(result.lat)
    const lng = parseFloat(result.lon)
    const name = result.display_name.split(',')[0].trim()

    if (isNaN(lat) || isNaN(lng)) {
      console.error('[resolve_place] Invalid coordinates from Nominatim')
      return jsonResponse({ error: 'Geocoding provider error' }, 502)
    }

    // Store in cache (fire and forget, don't block response)
    supabase
      .from('place_cache')
      .insert({
        q: trimmed,
        q_lower: qLower,
        lat,
        lng,
        name,
        provider: 'nominatim',
      })
      .then(({ error: insertError }) => {
        if (insertError) {
          // Might be duplicate, ignore
          console.log(`[resolve_place] Cache insert skipped (possibly duplicate): ${insertError.message}`)
        } else {
          console.log(`[resolve_place] Cached: ${qLower}`)
        }
      })

    return jsonResponse({
      ok: true,
      lat,
      lng,
      name,
      source: 'nominatim',
    })

  } catch (err) {
    console.error('[resolve_place] Unexpected error:', err)
    return jsonResponse({ error: 'Internal server error' }, 500)
  }
})
