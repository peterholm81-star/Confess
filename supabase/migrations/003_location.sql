-- Add location columns to confessions table
ALTER TABLE confessions ADD COLUMN lat DOUBLE PRECISION;
ALTER TABLE confessions ADD COLUMN lng DOUBLE PRECISION;

-- Index for location queries
CREATE INDEX confessions_location_idx ON confessions (lat, lng);

-- RPC: Get confessions within radius_m meters using Haversine formula
CREATE OR REPLACE FUNCTION get_confessions_near(
  user_lat DOUBLE PRECISION,
  user_lng DOUBLE PRECISION,
  radius_m INTEGER
)
RETURNS SETOF confessions
LANGUAGE sql
STABLE
AS $$
  SELECT *
  FROM confessions
  WHERE lat IS NOT NULL
    AND lng IS NOT NULL
    AND (
      6371000 * acos(
        cos(radians(user_lat)) * cos(radians(lat)) *
        cos(radians(lng) - radians(user_lng)) +
        sin(radians(user_lat)) * sin(radians(lat))
      )
    ) <= radius_m
  ORDER BY created_at DESC;
$$;
