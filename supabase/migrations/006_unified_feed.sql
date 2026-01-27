-- Migration: Unified feed system
-- Adds expires_at, is_hidden columns and creates a single RPC for all feed modes

-- Add expires_at column (default: 24 hours from creation)
ALTER TABLE confessions 
ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Backfill existing rows: set expires_at to created_at + 24 hours
UPDATE confessions 
SET expires_at = created_at + interval '24 hours' 
WHERE expires_at IS NULL;

-- Make expires_at NOT NULL with default
ALTER TABLE confessions 
ALTER COLUMN expires_at SET DEFAULT now() + interval '24 hours',
ALTER COLUMN expires_at SET NOT NULL;

-- Add is_hidden column for moderation
ALTER TABLE confessions 
ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN DEFAULT false;

-- Composite index for keyset pagination (created_at DESC, id DESC)
CREATE INDEX IF NOT EXISTS confessions_pagination_idx 
ON confessions (created_at DESC, id DESC);

-- Index for expiry filtering
CREATE INDEX IF NOT EXISTS confessions_expires_at_idx 
ON confessions (expires_at);

-- Index for moderation filtering
CREATE INDEX IF NOT EXISTS confessions_is_hidden_idx 
ON confessions (is_hidden) WHERE is_hidden = true;

-- Drop old RPC functions
DROP FUNCTION IF EXISTS get_confessions_nearby(DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, TIMESTAMPTZ, UUID, INTEGER);
DROP FUNCTION IF EXISTS get_confessions_near(DOUBLE PRECISION, DOUBLE PRECISION, INTEGER);

-- =============================================================================
-- UNIFIED FEED RPC: get_confess_feed
-- =============================================================================
-- Single function for all feed modes (world / near)
-- 
-- Parameters:
--   p_mode: 'world' | 'near'
--   p_limit: page size (clamped to 10-50, default 30)
--   p_cursor_created_at: cursor for keyset pagination (null for first page)
--   p_cursor_id: cursor id for tie-breaking
--   p_lat, p_lng: user location (required for 'near' mode)
--   p_radius_m: search radius in meters (clamped to 100-50000, default 10000)
--
-- Returns: TABLE of confession fields (NO select *)
-- 
-- Filters applied:
--   - expires_at > now() (only unexpired)
--   - COALESCE(is_hidden, false) = false (not hidden)
--   - For 'near': Haversine distance <= radius_m
--   - Keyset pagination: (created_at, id) < (cursor_created_at, cursor_id)
-- =============================================================================

CREATE OR REPLACE FUNCTION get_confess_feed(
  p_mode TEXT DEFAULT 'world',
  p_limit INTEGER DEFAULT 30,
  p_cursor_created_at TIMESTAMPTZ DEFAULT NULL,
  p_cursor_id UUID DEFAULT NULL,
  p_lat DOUBLE PRECISION DEFAULT NULL,
  p_lng DOUBLE PRECISION DEFAULT NULL,
  p_radius_m INTEGER DEFAULT 10000
)
RETURNS TABLE (
  id UUID,
  text TEXT,
  created_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  v_limit INTEGER;
  v_radius INTEGER;
BEGIN
  -- Clamp limit to [10, 50]
  v_limit := GREATEST(10, LEAST(50, COALESCE(p_limit, 30)));
  
  -- Clamp radius to [100, 50000] meters
  v_radius := GREATEST(100, LEAST(50000, COALESCE(p_radius_m, 10000)));

  IF p_mode = 'near' THEN
    -- Near mode: require lat/lng
    IF p_lat IS NULL OR p_lng IS NULL THEN
      RAISE EXCEPTION 'lat and lng are required for near mode';
    END IF;
    
    RETURN QUERY
    SELECT 
      c.id,
      c.text,
      c.created_at,
      c.expires_at,
      c.lat,
      c.lng
    FROM confessions c
    WHERE c.expires_at > now()
      AND COALESCE(c.is_hidden, false) = false
      AND c.lat IS NOT NULL
      AND c.lng IS NOT NULL
      -- Haversine distance in meters
      AND (
        6371000 * acos(
          LEAST(1.0, GREATEST(-1.0,
            cos(radians(p_lat)) * cos(radians(c.lat)) *
            cos(radians(c.lng) - radians(p_lng)) +
            sin(radians(p_lat)) * sin(radians(c.lat))
          ))
        )
      ) <= v_radius
      -- Keyset pagination
      AND (
        p_cursor_created_at IS NULL
        OR c.created_at < p_cursor_created_at
        OR (c.created_at = p_cursor_created_at AND c.id < p_cursor_id)
      )
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT v_limit;
    
  ELSE
    -- World mode: all confessions (no location filter)
    RETURN QUERY
    SELECT 
      c.id,
      c.text,
      c.created_at,
      c.expires_at,
      c.lat,
      c.lng
    FROM confessions c
    WHERE c.expires_at > now()
      AND COALESCE(c.is_hidden, false) = false
      -- Keyset pagination
      AND (
        p_cursor_created_at IS NULL
        OR c.created_at < p_cursor_created_at
        OR (c.created_at = p_cursor_created_at AND c.id < p_cursor_id)
      )
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT v_limit;
  END IF;
END;
$$;

-- Grant execute to anon role
GRANT EXECUTE ON FUNCTION get_confess_feed TO anon;
GRANT EXECUTE ON FUNCTION get_confess_feed TO authenticated;
