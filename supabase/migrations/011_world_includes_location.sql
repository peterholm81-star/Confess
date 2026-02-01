-- =============================================================================
-- Migration: 011_world_includes_location.sql
-- =============================================================================
-- RULE CLARIFICATION:
--   • World mode: Returns ALL confessions (with or without lat/lng)
--   • Near mode:  Returns only confessions WITH lat/lng within radius
-- 
-- World is the global feed showing everything.
-- Near is a geographic filter for location-tagged confessions only.
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
    -- =========================================================================
    -- NEAR MODE: Only confessions WITH lat/lng within radius
    -- =========================================================================
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
      -- Near mode requires location
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
    -- =========================================================================
    -- WORLD MODE: ALL confessions (both with and without lat/lng)
    -- =========================================================================
    -- No location filter - world shows everything regardless of coords
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
      -- NO lat/lng filter here - world includes ALL confessions
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

-- Ensure permissions are granted
GRANT EXECUTE ON FUNCTION get_confess_feed TO anon;
GRANT EXECUTE ON FUNCTION get_confess_feed TO authenticated;
