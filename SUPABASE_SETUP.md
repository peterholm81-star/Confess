# Supabase Setup for Confess

## 1. Create Project

1. Go to https://supabase.com/dashboard
2. Click "New Project"
3. Name: `confess`
4. Generate a strong database password (save it somewhere safe)
5. Region: Choose closest to your users
6. Click "Create new project"
7. Wait for project to be ready (~2 minutes)

## 2. Get Credentials

1. Go to Project Settings → API
2. Copy these values to your `.env` file:
   - `Project URL` → `VITE_SUPABASE_URL`
   - `anon public` key → `VITE_SUPABASE_ANON_KEY`

## 3. Run Migration

1. Go to SQL Editor in Supabase dashboard
2. Paste contents of `supabase/migrations/001_confessions.sql`
3. Click "Run"

## 4. Set Up Scheduled Cleanup

1. Go to SQL Editor
2. Paste contents of `supabase/migrations/002_cleanup_cron.sql`
3. Click "Run"

Note: pg_cron is enabled by default on Supabase projects.

## 5. Verify

1. Go to Table Editor → confessions table should exist
2. Go to Database → Extensions → pg_cron should be enabled
3. Test by inserting a row manually, then selecting from the table
