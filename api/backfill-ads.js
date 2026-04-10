// Peekr — Backfill live_ads for existing shops via Store Leads API
// Call: GET /api/backfill-ads?batch=100&offset=0
// Re-fetches top shops from Store Leads sorted by traffic to get ad data

const SUPABASE_URL = 'https://vsyceexjsitliwaasdhd.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZzeWNlZXhqc2l0bGl3YWFzZGhkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0NDgzNzYsImV4cCI6MjA5MDAyNDM3Nn0.nng6CrCZIYiW3i-b3z5hm6AXhepA8t1CUhZ1Kt4aZwo';
const STORELEADS_KEY = '0828c887-79f6-45b0-5ea9-e3427cb4';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const batchSize = Math.min(parseInt(req.query.batch) || 50, 50);
  const offset = parseInt(req.query.offset) || 0;
  const country = req.query.country || 'US';
  const sort = req.query.sort || 'estimated_visits';

  const startTime = Date.now();
  let updated = 0;
  let checked = 0;
  let withAds = 0;
  const details = [];

  try {
    // Fetch from Store Leads with ad data
    const slUrl = `https://storeleads.app/json/api/v1/all/domain?p=shopify&ds=active&sort=${sort}&limit=${batchSize}&offset=${offset}&c=${country}`;

    const slResp = await fetch(slUrl, {
      headers: { 'Authorization': `Token ${STORELEADS_KEY}` },
      signal: AbortSignal.timeout(15000)
    });

    if (!slResp.ok) {
      return res.status(500).json({ error: `Store Leads API error: ${slResp.status}`, body: await slResp.text() });
    }

    const slData = await slResp.json();
    const domains = slData.domains || [];
    checked = domains.length;

    // Process each domain — update live_ads + any missing fields
    for (const d of domains) {
      const liveAds = d.facebook_ad_count || d.ad_count || d.facebook_ads || d.live_ads || 0;
      const adPlatforms = d.ad_platforms || d.advertising || [];

      const updateData = {
        live_ads: liveAds,
        ad_platforms: Array.isArray(adPlatforms) ? adPlatforms : [],
        estimated_sales: d.estimated_sales || 0,
        estimated_sales_yearly: d.estimated_sales_yearly || 0,
        monthly_visits: d.estimated_visits || 0,
        products_count: d.product_count || 0,
        platform_rank: d.platform_rank,
        global_rank: d.rank,
        rank_percentile: d.rank_percentile,
        avg_price_usd: d.avg_price_usd,
        monthly_app_spend: d.monthly_app_spend,
        employee_count: d.employee_count,
        vendor_count: d.vendor_count,
        variant_count: d.variant_count,
        apps: Array.isArray(d.apps) ? d.apps : [],
        technologies: Array.isArray(d.technologies) ? d.technologies : [],
        categories: Array.isArray(d.categories) ? d.categories : [],
        created_date: d.created_at ? d.created_at.split('T')[0] : null,
        theme: d.theme?.name || d.theme || null,
        currency: d.currency_code || null,
        language: d.language_code || null,
        shopify_plan: d.plan || null,
        ships_to: d.ships_to_countries || [],
        traffic_trend: d.traffic_trend || [],
        visitor_countries: d.visitor_countries || [],
        strategies: d.strategies || [],
        description: d.description,
        city: d.city,
        region: d.region,
        icon: d.icon,
        storeleads_updated_at: d.last_updated_at,
        last_scraped: new Date().toISOString()
      };

      // Upsert — will update if domain exists, insert if not
      const upResp = await fetch(`${SUPABASE_URL}/rest/v1/shops`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          domain: d.name,
          name: d.merchant_name || d.title || d.name,
          title: d.title,
          merchant_name: d.merchant_name,
          niche: detectNiche(Array.isArray(d.categories) ? d.categories.join(',') : ''),
          score: calculateScore(d.estimated_visits || 0, d.estimated_sales || 0, d.platform_rank || 999999, d.product_count || 0, Array.isArray(d.apps) ? d.apps.length : 0),
          trend_tag: getTrendTag(calculateScore(d.estimated_visits || 0, d.estimated_sales || 0, d.platform_rank || 999999, d.product_count || 0, Array.isArray(d.apps) ? d.apps.length : 0)),
          country: d.country_code || country,
          ...updateData
        })
      });

      if (upResp.ok) {
        updated++;
        if (liveAds > 0) withAds++;
        details.push({ domain: d.name, live_ads: liveAds, visits: d.estimated_visits });
      }
    }

    const elapsed = Date.now() - startTime;
    return res.status(200).json({
      success: true,
      checked,
      updated,
      withAds,
      nextOffset: offset + batchSize,
      elapsed_ms: elapsed,
      sample: details.slice(0, 10)
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
      checked,
      updated
    });
  }
};

// Reuse scoring functions
function calculateScore(visits, sales, rank, products, apps) {
  let sc = 0;
  if (visits > 1000000) sc += 30; else if (visits > 500000) sc += 25; else if (visits > 100000) sc += 20; else if (visits > 50000) sc += 15; else if (visits > 10000) sc += 10; else if (visits > 1000) sc += 5;
  if (sales > 1000000000) sc += 25; else if (sales > 100000000) sc += 20; else if (sales > 50000000) sc += 15; else if (sales > 10000000) sc += 10; else if (sales > 1000000) sc += 5;
  if (rank <= 100) sc += 20; else if (rank <= 500) sc += 16; else if (rank <= 2000) sc += 12; else if (rank <= 10000) sc += 8; else if (rank <= 50000) sc += 4;
  if (products > 1000) sc += 15; else if (products > 500) sc += 12; else if (products > 100) sc += 9; else if (products > 20) sc += 6; else if (products > 5) sc += 3;
  if (apps > 10) sc += 10; else if (apps > 5) sc += 7; else if (apps > 2) sc += 4; else if (apps > 0) sc += 2;
  return Math.min(Math.max(sc, 0), 100);
}

function getTrendTag(score) {
  if (score >= 75) return 'hot';
  if (score >= 55) return 'rising';
  if (score >= 35) return 'watch';
  return 'cold';
}

function detectNiche(categories) {
  const cats = (categories || '').toLowerCase();
  if (cats.includes('beauty') || cats.includes('cosmetic') || cats.includes('skincare')) return 'Beauty';
  if (cats.includes('fashion') || cats.includes('apparel') || cats.includes('clothing')) return 'Fashion';
  if (cats.includes('health') || cats.includes('wellness') || cats.includes('fitness')) return 'Health';
  if (cats.includes('food') || cats.includes('drink') || cats.includes('grocery')) return 'Food & Drink';
  if (cats.includes('tech') || cats.includes('electronic')) return 'Tech';
  if (cats.includes('home') || cats.includes('furniture') || cats.includes('decor')) return 'Home & Living';
  if (cats.includes('pet') || cats.includes('animal')) return 'Pets';
  if (cats.includes('sport') || cats.includes('outdoor')) return 'Sports';
  if (cats.includes('jewel') || cats.includes('watch') || cats.includes('accessor')) return 'Jewelry';
  if (cats.includes('toy') || cats.includes('game') || cats.includes('kid')) return 'Toys';
  if (cats.includes('auto') || cats.includes('car') || cats.includes('vehicle')) return 'Automotive';
  return 'General';
}
