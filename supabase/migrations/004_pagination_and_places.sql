-- places_cache table for popular places (Somewhere tab)
CREATE TABLE places_cache (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- RLS: Anyone can read places_cache
ALTER TABLE places_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read places_cache"
  ON places_cache
  FOR SELECT
  TO anon
  USING (true);

-- Seed some popular places
INSERT INTO places_cache (name, lat, lng) VALUES
  ('New York', 40.7128, -74.0060),
  ('London', 51.5074, -0.1278),
  ('Tokyo', 35.6762, 139.6503),
  ('Paris', 48.8566, 2.3522),
  ('Sydney', -33.8688, 151.2093),
  ('Berlin', 52.5200, 13.4050),
  ('Toronto', 43.6532, -79.3832),
  ('Singapore', 1.3521, 103.8198),
  ('Dubai', 25.2048, 55.2708),
  ('Oslo', 59.9139, 10.7522);

-- Drop old RPC if exists
DROP FUNCTION IF EXISTS get_confessions_near(DOUBLE PRECISION, DOUBLE PRECISION, INTEGER);

-- New RPC with keyset pagination support
CREATE OR REPLACE FUNCTION get_confessions_nearby(
  user_lat DOUBLE PRECISION,
  user_lng DOUBLE PRECISION,
  radius_m INTEGER,
  before_created_at TIMESTAMPTZ,
  before_id UUID,
  page_limit INTEGER
)
RETURNS SETOF confessions
LANGUAGE sql
STABLE
AS $$
  SELECT *
  FROM confessions
  WHERE lat IS NOT NULL
    AND lng IS NOT NULL
    AND created_at >= now() - interval '24 hours'
    AND (
      6371000 * acos(
        cos(radians(user_lat)) * cos(radians(lat)) *
        cos(radians(lng) - radians(user_lng)) +
        sin(radians(user_lat)) * sin(radians(lat))
      )
    ) <= radius_m
    AND (
      created_at < before_created_at
      OR (created_at = before_created_at AND id < before_id)
    )
  ORDER BY created_at DESC, id DESC
  LIMIT page_limit;
$$;
