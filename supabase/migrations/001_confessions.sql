-- Create confessions table
CREATE TABLE confessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  text TEXT NOT NULL CHECK (char_length(text) <= 120),
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Index for ordering by created_at (newest first)
CREATE INDEX confessions_created_at_idx ON confessions (created_at DESC);

-- Enable Row Level Security
ALTER TABLE confessions ENABLE ROW LEVEL SECURITY;

-- Policy: Anyone can insert
CREATE POLICY "Anyone can insert confessions"
  ON confessions
  FOR INSERT
  TO anon
  WITH CHECK (true);

-- Policy: Anyone can select
CREATE POLICY "Anyone can read confessions"
  ON confessions
  FOR SELECT
  TO anon
  USING (true);

-- No UPDATE or DELETE policies = clients cannot modify or delete
