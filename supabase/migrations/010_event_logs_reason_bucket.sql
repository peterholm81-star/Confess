-- ============================================================================
-- Migration: 010_event_logs_reason_bucket
-- Purpose: Add reason_bucket column for rejection analytics
-- ============================================================================

-- Add reason_bucket column (nullable, no breaking change)
ALTER TABLE public.event_logs
ADD COLUMN IF NOT EXISTS reason_bucket TEXT;

-- Add comment for documentation
COMMENT ON COLUMN public.event_logs.reason_bucket IS 'Bucketed rejection reason for post_reject events: validation, rate_limit, network';
