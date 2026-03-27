/**
 * Peekr — Store Leads Import Script
 *
 * Fetches Shopify store data from Store Leads API and imports into Supabase.
 * Run this in the browser console (or as a Supabase Edge Function).
 *
 * Config:
 *   STORE_LEADS_API_KEY - Your Store Leads API key
 *   SUPABASE_URL - Your Supabase project URL
 *   SUPABASE_KEY - Your Supabase service role key (for server-side inserts)
 */

const CONFIG = {
  STORE_LEADS_API_KEY: '0828c887-79f6-45b0-5ea9-e3427cb4',
  STORE_LEADS_BASE: 'https://storeleads.app/json/api/v1/all',
  SUPABASE_URL: 'https://vsyceexjsitliwaasdhd.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZzeWNlZXhqc2l0bGl3YWFzZGhkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0NDgzNzYsImV4cCI6MjA5MDAyNDM3Nn0.nng6CrCZIYiW3i-b3z5hm6AXhepA8t1CUhZ1Kt4aZwo',
  BATCH_SIZE: 50,       // Store Leads returns max 50 per page
  MAX_PAGES: 20,        // 20 pages × 50 = 1000 shops per import
  DELAY_MS: 1200        // Delay between API calls to respect rate limits
};

// Helper: sleep
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Helper: format revenue range from cents
function formatRevenue(salesCents) {
  if (!salesCents) return { min: 0, max: 0, display: '$0' };
  const sales = salesCents / 100;
  const min = Math.round(sales * 0.8);
  const max = Math.round(sales * 1.2);
  if (sales >= 1000000) return { min, max, display: `$${(sales/1000000).toFixed(1)}M` };
  if (sales >= 1000) return { min, max, display: `$${(sales/1000).toFixed(0)}K` };
  return { min, max, display: `$${sales.toFixed(0)}` };
}

// Helper: format visits
function formatVisits(visits) {
  if (!visits) return '0';
  if (visits >= 1000000) return `${(visits/1000000).toFixed(1)}M`;
  if (visits >= 1000) return `${(visits/1000).toFixed(0)}K`;
  return visits.toString();
}

// Helper: extract niche from Store Leads categories
function extractNiche(categories) {
  if (!categories || !categories.length) return 'General';
  // Map Store Leads categories to Peekr niches
  const nicheMap = {
    'beauty': 'Beauty', 'fitness': 'Fitness', 'apparel': 'Fashion',
    'fashion': 'Fashion', 'clothing': 'Fashion', 'health': 'Health',
    'food': 'Food & Drink', 'drink': 'Food & Drink', 'home': 'Home & Living',
    'garden': 'Home & Living', 'furniture': 'Home & Living',
    'electronics': 'Tech', 'tech': 'Tech', 'computer': 'Tech',
    'pet': 'Pets', 'animal': 'Pets', 'jewelry': 'Jewelry',
    'accessories': 'Accessories', 'sport': 'Sports', 'outdoor': 'Sports',
    'toys': 'Toys & Games', 'games': 'Toys & Games', 'baby': 'Baby & Kids',
    'kids': 'Baby & Kids', 'children': 'Baby & Kids', 'auto': 'Automotive',
    'car': 'Automotive', 'art': 'Art & Design', 'book': 'Books & Media',
    'music': 'Books & Media', 'travel': 'Travel'
  };

  for (const cat of categories) {
    const catLower = cat.toLowerCase();
    for (const [key, value] of Object.entries(nicheMap)) {
      if (catLower.includes(key)) return value;
    }
  }
  // Return first category cleaned up
  const first = categories[0].split('/').filter(Boolean).pop();
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : 'General';
}

// Helper: calculate score
function calculateScore(domain) {
  let score = 0;
  const visits = domain.estimated_visits || 0;
  const sales = domain.estimated_sales || 0;
  const rank = domain.platform_rank || 999999;
  const products = domain.product_count || 0;
  const appsCount = domain.apps?.length || 0;

  // Traffic (0-30)
  if (visits > 1000000) score += 30;
  else if (visits > 500000) score += 25;
  else if (visits > 100000) score += 20;
  else if (visits > 50000) score += 15;
  else if (visits > 10000) score += 10;
  else if (visits > 1000) score += 5;

  // Revenue (0-25)
  if (sales > 1000000000) score += 25;
  else if (sales > 100000000) score += 20;
  else if (sales > 50000000) score += 15;
  else if (sales > 10000000) score += 10;
  else if (sales > 1000000) score += 5;

  // Rank (0-20)
  if (rank <= 100) score += 20;
  else if (rank <= 500) score += 16;
  else if (rank <= 2000) score += 12;
  else if (rank <= 10000) score += 8;
  else if (rank <= 50000) score += 4;

  // Products (0-15)
  if (products > 1000) score += 15;
  else if (products > 500) score += 12;
  else if (products > 100) score += 9;
  else if (products > 20) score += 6;
  else if (products > 5) score += 3;

  // Apps (0-10)
  if (appsCount > 10) score += 10;
  else if (appsCount > 5) score += 7;
  else if (appsCount > 2) score += 4;
  else if (appsCount > 0) score += 2;

  return Math.min(Math.max(Math.round(score), 0), 100);
}

// Helper: determine trend tag
function getTrendTag(score) {
  if (score >= 75) return 'hot';
  if (score >= 55) return 'rising';
  if (score >= 35) return 'watch';
  return 'cold';
}

// Transform Store Leads domain to Peekr shop format
function transformDomain(d) {
  const revenue = formatRevenue(d.estimated_sales);
  const score = calculateScore(d);
  const apps = d.apps ? d.apps.map(a => typeof a === 'string' ? a : a.name).filter(Boolean) : [];

  return {
    name: d.merchant_name || d.title || d.name,
    domain: d.name,
    title: d.title,
    merchant_name: d.merchant_name,
    niche: extractNiche(d.categories),
    score: score,
    trend_tag: getTrendTag(score),
    country: d.country_code || 'US',
    created_date: d.created_at ? d.created_at.split('T')[0] : null,
    monthly_visits: d.estimated_visits || 0,
    revenue_min: revenue.min,
    revenue_max: revenue.max,
    estimated_sales: d.estimated_sales || 0,
    estimated_sales_yearly: d.estimated_sales_yearly || 0,
    estimated_page_views: d.estimated_page_views || 0,
    theme: d.theme?.name || 'Unknown',
    currency: d.currency_code || 'USD',
    language: d.language_code || 'en',
    products_count: d.product_count || 0,
    shopify_plan: d.plan || 'Unknown',
    apps: apps.slice(0, 20), // limit to 20 apps
    categories: d.categories || [],
    technologies: (d.technologies || []).map(t => typeof t === 'string' ? t : t.name).filter(Boolean).slice(0, 30),
    platform_rank: d.platform_rank,
    global_rank: d.rank,
    rank_percentile: d.rank_percentile,
    avg_price_usd: d.avg_price_usd,
    monthly_app_spend: d.monthly_app_spend,
    employee_count: d.employee_count,
    vendor_count: d.vendor_count,
    variant_count: d.variant_count,
    description: d.description,
    city: d.city,
    region: d.region,
    icon: d.icon,
    ships_to: d.ships_to_countries || [],
    storeleads_updated_at: d.last_updated_at,
    last_scraped: new Date().toISOString()
  };
}

// Fetch domains from Store Leads API
async function fetchStoreLeads(page = 1, filters = {}) {
  const params = new URLSearchParams({
    p: 'shopify',
    ds: 'active',
    sort: filters.sort || 'rank',
    limit: CONFIG.BATCH_SIZE,
    offset: (page - 1) * CONFIG.BATCH_SIZE
  });

  // Optional filters
  if (filters.country) params.set('c', filters.country);
  if (filters.category) params.set('cat', filters.category);
  if (filters.createdAfter) params.set('cmin', filters.createdAfter);

  const url = `${CONFIG.STORE_LEADS_BASE}/domain?${params}`;
  console.log(`[Peekr Import] Fetching page ${page}: ${url}`);

  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${CONFIG.STORE_LEADS_API_KEY}` }
  });

  if (!resp.ok) {
    throw new Error(`Store Leads API error: ${resp.status} ${resp.statusText}`);
  }

  return resp.json();
}

// Upsert shops into Supabase
async function upsertToSupabase(shops) {
  const url = `${CONFIG.SUPABASE_URL}/rest/v1/shops`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': CONFIG.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify(shops)
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Supabase upsert error: ${resp.status} - ${err}`);
  }

  return resp.status;
}

// Main import function
async function importShops(options = {}) {
  const maxPages = options.maxPages || CONFIG.MAX_PAGES;
  const filters = options.filters || {};
  let totalImported = 0;
  let totalSkipped = 0;

  console.log(`[Peekr Import] Starting import — max ${maxPages} pages × ${CONFIG.BATCH_SIZE} shops`);

  for (let page = 1; page <= maxPages; page++) {
    try {
      const data = await fetchStoreLeads(page, filters);

      if (!data.domains || data.domains.length === 0) {
        console.log(`[Peekr Import] No more results at page ${page}. Done.`);
        break;
      }

      // Transform domains to Peekr format
      const shops = data.domains
        .filter(d => d.name && d.estimated_visits > 0) // Skip dead stores
        .map(transformDomain);

      if (shops.length === 0) {
        console.log(`[Peekr Import] Page ${page}: no valid shops after filtering`);
        continue;
      }

      // Upsert into Supabase
      const status = await upsertToSupabase(shops);
      totalImported += shops.length;
      totalSkipped += data.domains.length - shops.length;

      console.log(`[Peekr Import] Page ${page}/${maxPages}: imported ${shops.length} shops (${totalImported} total, ${totalSkipped} skipped)`);

      // Respect rate limits
      if (page < maxPages) {
        await sleep(CONFIG.DELAY_MS);
      }

    } catch (err) {
      console.error(`[Peekr Import] Error on page ${page}:`, err.message);
      // Wait longer on error then retry
      await sleep(3000);
    }
  }

  console.log(`[Peekr Import] ✅ Complete! Imported ${totalImported} shops, skipped ${totalSkipped}`);
  return { imported: totalImported, skipped: totalSkipped };
}

// Export for use
window.PeekrImport = { importShops, fetchStoreLeads, transformDomain, upsertToSupabase, CONFIG };
console.log('[Peekr Import] Script loaded. Run PeekrImport.importShops() to start.');
console.log('[Peekr Import] Options: importShops({ maxPages: 5, filters: { country: "US" } })');
