// Edge function: cleanup_confessions
// Deletes confessions older than 24 hours
// Run via cron or manual trigger

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  const headers = {
    'Content-Type': 'application/json',
  }

  try {
    // Use service role key for server-side operations
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('[cleanup] Missing environment variables')
      return new Response(
        JSON.stringify({ ok: false, error: 'Missing configuration' }),
        { status: 500, headers }
      )
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    console.log('[cleanup] Starting cleanup of confessions older than 24 hours')

    // Delete old confessions and get count
    const { data, error } = await supabase
      .from('confessions')
      .delete()
      .lt('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .select('id')

    if (error) {
      console.error('[cleanup] Delete error:', error.message)
      return new Response(
        JSON.stringify({ ok: false, error: error.message }),
        { status: 500, headers }
      )
    }

    const deleted = data?.length || 0
    console.log(`[cleanup] Deleted ${deleted} confessions`)

    return new Response(
      JSON.stringify({ ok: true, deleted }),
      { status: 200, headers }
    )

  } catch (err) {
    console.error('[cleanup] Unexpected error:', err)
    return new Response(
      JSON.stringify({ ok: false, error: 'Unexpected error' }),
      { status: 500, headers }
    )
  }
})
