-- Enable pg_cron extension (usually already enabled on Supabase)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Schedule cleanup job: runs every hour, deletes rows older than 24 hours
SELECT cron.schedule(
  'cleanup-old-confessions',
  '0 * * * *',  -- every hour at minute 0
  $$DELETE FROM confessions WHERE created_at < now() - interval '24 hours'$$
);
