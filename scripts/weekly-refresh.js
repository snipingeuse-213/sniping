/**
 * Peekr — Weekly Data Refresh Script
 *
 * Calls the weekly_refresh() Supabase function which:
 * 1. Re-imports ~1000 shops from Store Leads API (with fresh data)
 * 2. Takes a traffic snapshot for trend tracking
 * 3. Updates traffic_trend arrays on all shops
 *
 * Can be run:
 * - Manually via browser console on any page
 * - As a scheduled Supabase Edge Function (cron)
 * - Via external cron service calling the RPC endpoint
 *
 * RPC Endpoint: POST https://vsyceexjsitliwaasdhd.supabase.co/rest/v1/rpc/weekly_refresh
 */

const SUPABASE_URL = 'https://vsyceexjsitliwaasdhd.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZzeWNlZXhqc2l0bGl3YWFzZGhkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0NDgzNzYsImV4cCI6MjA5MDAyNDM3Nn0.nng6CrCZIYiW3i-b3z5hm6AXhepA8t1CUhZ1Kt4aZwo';

async function weeklyRefresh() {
  console.log('[Peekr Weekly] Starting weekly refresh...');

  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/weekly_refresh`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`RPC error ${resp.status}: ${err}`);
    }

    const result = await resp.json();
    console.log('[Peekr Weekly] ✅ Complete!', result);
    console.log(`  Shops imported: ${result[0]?.shops_imported || 0}`);
    console.log(`  Shops snapped: ${result[0]?.shops_snapped || 0}`);
    console.log(`  Week: ${result[0]?.week || 'unknown'}`);
    return result;
  } catch (err) {
    console.error('[Peekr Weekly] ❌ Error:', err.message);
    throw err;
  }
}

// Also provide a snapshot-only function
async function snapshotOnly() {
  console.log('[Peekr] Taking traffic snapshot...');
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/snapshot_traffic`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: '{}'
  });
  const result = await resp.json();
  console.log('[Peekr] Snapshot result:', result);
  return result;
}

// Export
if (typeof window !== 'undefined') {
  window.PeekrRefresh = { weeklyRefresh, snapshotOnly };
  console.log('[Peekr Weekly] Script loaded. Run PeekrRefresh.weeklyRefresh() to start.');
}
