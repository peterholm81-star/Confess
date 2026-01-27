-- place_cache table for geocoding results
CREATE TABLE place_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  q TEXT NOT NULL,
  q_lower TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'nominatim',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique index on normalized query (case-insensitive lookup)
CREATE UNIQUE INDEX place_cache_q_lower_idx ON place_cache (q_lower);

-- Index for cleanup by age if needed
CREATE INDEX place_cache_created_at_idx ON place_cache (created_at);

-- Enable RLS
ALTER TABLE place_cache ENABLE ROW LEVEL SECURITY;

-- Allow anyone to read (for frontend fallback if needed)
CREATE POLICY "Anyone can read place_cache"
  ON place_cache
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- No INSERT/UPDATE/DELETE for clients
-- Only service role (used by Edge Function) can write
