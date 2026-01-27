-- Migration: Server-controlled insert pipeline
-- Adds user_id for rate limiting and creates insert_confession RPC

-- =============================================================================
-- ADD USER_ID COLUMN FOR RATE LIMITING
-- =============================================================================

-- Add user_id column to track anonymous auth users
ALTER TABLE confessions 
ADD COLUMN IF NOT EXISTS user_id UUID;

-- Index for rate limiting queries (user's recent posts)
CREATE INDEX IF NOT EXISTS confessions_user_rate_limit_idx 
ON confessions (user_id, created_at DESC) 
WHERE user_id IS NOT NULL;

-- =============================================================================
-- INSERT CONFESSION RPC
-- =============================================================================
-- Server-controlled insert with:
-- - Text validation (trim, empty check, max 120 chars)
-- - Server-set expires_at (now + 24h)
-- - Server-set is_hidden (false)
-- - Rate limiting (1 confession per 15 seconds per user)
-- - Optional geo (lat/lng stored in existing columns)
-- 
-- Returns: inserted row (selected fields only, no SELECT *)
-- =============================================================================

CREATE OR REPLACE FUNCTION insert_confession(
  p_text TEXT,
  p_place_label TEXT DEFAULT NULL,
  p_lat DOUBLE PRECISION DEFAULT NULL,
  p_lng DOUBLE PRECISION DEFAULT NULL
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
SECURITY DEFINER
AS $$
DECLARE
  v_text TEXT;
  v_user_id UUID;
  v_last_post TIMESTAMPTZ;
  v_inserted_id UUID;
BEGIN
  -- Get current user (anonymous or authenticated)
  v_user_id := auth.uid();
  
  -- Trim and validate text
  v_text := btrim(p_text);
  
  IF v_text IS NULL OR v_text = '' THEN
    RAISE EXCEPTION 'EMPTY_TEXT: Confession text cannot be empty';
  END IF;
  
  IF char_length(v_text) > 120 THEN
    RAISE EXCEPTION 'TEXT_TOO_LONG: Confession must be 120 characters or less';
  END IF;
  
  -- Rate limiting: check for recent post by this user (if user_id available)
  IF v_user_id IS NOT NULL THEN
    SELECT c.created_at INTO v_last_post
    FROM confessions c
    WHERE c.user_id = v_user_id
    ORDER BY c.created_at DESC
    LIMIT 1;
    
    IF v_last_post IS NOT NULL AND v_last_post > now() - interval '15 seconds' THEN
      RAISE EXCEPTION 'RATE_LIMIT: Please wait before posting again';
    END IF;
  END IF;
  
  -- Insert the confession
  INSERT INTO confessions (
    text,
    lat,
    lng,
    expires_at,
    is_hidden,
    user_id
  ) VALUES (
    v_text,
    p_lat,
    p_lng,
    now() + interval '24 hours',
    false,
    v_user_id
  )
  RETURNING confessions.id INTO v_inserted_id;
  
  -- Return the inserted row (selected fields only)
  RETURN QUERY
  SELECT 
    c.id,
    c.text,
    c.created_at,
    c.expires_at,
    c.lat,
    c.lng
  FROM confessions c
  WHERE c.id = v_inserted_id;
END;
$$;

-- Grant execute to anon and authenticated roles
GRANT EXECUTE ON FUNCTION insert_confession TO anon;
GRANT EXECUTE ON FUNCTION insert_confession TO authenticated;

-- =============================================================================
-- UPDATE RLS POLICIES
-- =============================================================================
-- Keep existing select policy, update insert to prefer RPC usage
-- The RPC uses SECURITY DEFINER so it bypasses RLS for the insert

-- Drop old insert policy (we now use RPC)
DROP POLICY IF EXISTS "Anyone can insert confessions" ON confessions;

-- Create new restrictive insert policy (RPC bypasses this with SECURITY DEFINER)
-- This prevents direct table inserts while allowing RPC to work
CREATE POLICY "Insert via RPC only"
  ON confessions
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (false);

-- Note: The RPC uses SECURITY DEFINER, so it runs as the function owner
-- and bypasses RLS. Direct table inserts are blocked by the policy above.
