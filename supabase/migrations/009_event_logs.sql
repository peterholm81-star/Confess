-- ============================================================================
-- Migration: 009_event_logs
-- Purpose: Anonymous analytics events (privacy-first, append-only)
-- ============================================================================

-- Create event_logs table
CREATE TABLE IF NOT EXISTS public.event_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  day_bucket DATE NOT NULL,
  time_bucket INT NOT NULL CHECK (time_bucket >= 0 AND time_bucket <= 23),
  mode TEXT,
  city_code TEXT,
  language_detected TEXT,
  emotion_bucket TEXT,
  session_hash TEXT
);

-- Add comment for documentation
COMMENT ON TABLE public.event_logs IS 'Anonymous analytics events. No user identity, no IP, no device fingerprint. Append-only.';

-- Create index for time-based queries
CREATE INDEX IF NOT EXISTS idx_event_logs_day_bucket ON public.event_logs (day_bucket);
CREATE INDEX IF NOT EXISTS idx_event_logs_event_name ON public.event_logs (event_name);

-- Enable RLS
ALTER TABLE public.event_logs ENABLE ROW LEVEL SECURITY;

-- Policy: Allow anon to INSERT only
CREATE POLICY "anon_insert_event_logs"
  ON public.event_logs
  FOR INSERT
  TO anon
  WITH CHECK (true);

-- Policy: Allow authenticated to INSERT only
CREATE POLICY "auth_insert_event_logs"
  ON public.event_logs
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- No SELECT, UPDATE, DELETE policies for anon/authenticated
-- Only service_role (admin) can read via bypassing RLS
