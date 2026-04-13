// Peekr — Backfill live_ads by parsing technologies already in DB
// Strategy: Read shops from Supabase, count advertising technologies, PATCH update live_ads
// Uses PATCH (not POST) because POST upsert uses PK not domain unique constraint
//
// IMPORTANT: technologies column is text[] (Postgres array of JSON strings)
// Each element is a JSON string like '{"name":"Google Adsense","categories":["Advertising"]}'
//
// Endpoints:
//   GET /api/backfill-ads?action=scan&batch=200&offset=0  — scan DB, update live_ads for shops with live_ads=0
//   GET /api/backfill-ads?action=scan-all&batch=200&offset=0 — scan ALL shops, recount
//   GET /api/backfill-ads?action=revert&domain=gymshark.com — reset a shop's live_ads
//   GET /api/backfill-ads?action=stats — show current live_ads distribution
//   GET /api/backfill-ads?action=enrich&batch=50&offset=0 — fetch from Store Leads + PATCH
//   GET /api/backfill-ads?action=meta-sync&batch=10&offset=0 — sync live ads via Meta Graph API
//   GET /api/backfill-ads?action=live-lookup&domains=a.com,b.com — real-time lookup with 72h cache
//   GET /api/backfill-ads?action=ads-history&domain=gymshark.com&range=6m — historical ad count chart data
//   GET /api/backfill-ads?action=trustpilot&domain=gymshark.com — scrape Trustpilot rating & review count
//   GET /api/backfill-ads?action=ad-creatives&domain=gymshark.com&limit=20 — fetch Meta ad creatives
//   GET /api/backfill-ads?action=meta-debug&q=gymshark — diagnostic endpoint

const SUPABASE_URL = 'https://vsyceexjsitliwaasdhd.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZzeWNlZXhqc2l0bGl3YWFzZGhkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0NDgzNzYsImV4cCI6MjA5MDAyNDM3Nn0.nng6CrCZIYiW3i-b3z5hm6AXhepA8t1CUhZ1Kt4aZwo';

const HEADERS = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json'
};

// Parse a technology entry — it can be a JSON string or already an object
function parseTech(tech) {
  if (typeof tech === 'string') {
    try { return JSON.parse(tech); } catch (e) { return { name: tech }; }
  }
  if (typeof tech === 'object' && tech !== null) return tech;
  return null;
}

// Count advertising technologies in a shop's technologies array
function countAdTechs(technologies) {
  if (!Array.isArray(technologies) || technologies.length === 0) return { count: 0, adPlatforms: [] };

  let count = 0;
  const adPlatforms = [];

  for (const rawTech of technologies) {
    const tech = parseTech(rawTech);
    if (!tech) continue;

    const name = tech.name || '';
    const categories = tech.categories || [];

    // Check categories for advertising-related
    const isAdCategory = categories.some(c =>
      /advertising|ad network|ad exchange|retargeting|remarketing|ad server|ad management/i.test(
        typeof c === 'string' ? c : ''
      )
    );

    // Check by known ad platform names (broader matching)
    const isKnownAdPlatform = /facebook\s*(ads|pixel)|meta\s*(ads|pixel)|google\s*ads|tiktok\s*(ads|pixel)|snapchat\s*(ads|pixel)|pinterest\s*(ads|pixel)|bing\s*ads|microsoft\s*ads|criteo|adroll|taboola|outbrain|amazon\s*ads|doubleclick|adsense|adwords|facebook\s*conversions?\s*api/i.test(name);

    if (isAdCategory || isKnownAdPlatform) {
      count++;
      adPlatforms.push(name);
    }
  }

  return { count, adPlatforms };
}

// PATCH a single shop's live_ads
async function patchShop(domain, liveAds, adPlatforms) {
  const url = `${SUPABASE_URL}/rest/v1/shops?domain=eq.${encodeURIComponent(domain)}`;
  const body = { live_ads: liveAds };
  if (adPlatforms && adPlatforms.length > 0) {
    body.ad_platforms = adPlatforms;
  }

  const resp = await fetch(url, {
    method: 'PATCH',
    headers: HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000)
  });

  return resp.ok;
}

// ACTION: scan — Read shops from DB with live_ads=0, count ad techs, update
async function actionScan(req, res) {
  const batchSize = Math.min(parseInt(req.query.batch) || 200, 500);
  const offset = parseInt(req.query.offset) || 0;
  const startTime = Date.now();
  let updated = 0;
  let checked = 0;
  let skipped = 0;
  const samples = [];

  const queryUrl = `${SUPABASE_URL}/rest/v1/shops?select=domain,technologies,live_ads&technologies=not.is.null&or=(live_ads.eq.0,live_ads.is.null)&order=score.desc.nullslast&limit=${batchSize}&offset=${offset}`;

  const fetchResp = await fetch(queryUrl, {
    headers: HEADERS,
    signal: AbortSignal.timeout(15000)
  });

  if (!fetchResp.ok) {
    const errText = await fetchResp.text();
    return res.status(500).json({ error: `Supabase fetch error: ${fetchResp.status}`, body: errText.slice(0, 500) });
  }

  const shops = await fetchResp.json();
  checked = shops.length;

  if (checked === 0) {
    return res.status(200).json({
      success: true,
      message: 'No more shops to process at this offset',
      checked: 0, updated: 0, offset,
      elapsed_ms: Date.now() - startTime
    });
  }

  const PARALLEL = 20;
  for (let i = 0; i < shops.length; i += PARALLEL) {
    const batch = shops.slice(i, i + PARALLEL);
    if (Date.now() - startTime > 50000) break;

    const promises = batch.map(async (shop) => {
      try {
        const techs = shop.technologies;
        if (!Array.isArray(techs) || techs.length === 0) return 'skipped';

        const result = countAdTechs(techs);

        if (result.count > 0) {
          const ok = await patchShop(shop.domain, result.count, result.adPlatforms);
          if (ok) {
            samples.push({ domain: shop.domain, live_ads: result.count, platforms: result.adPlatforms.slice(0, 5) });
            return 'updated';
          }
          return 'error';
        }
        return 'skipped';
      } catch (e) {
        return 'error';
      }
    });

    const results = await Promise.allSettled(promises);
    for (const r of results) {
      if (r.status === 'fulfilled') {
        if (r.value === 'updated') updated++;
        else if (r.value === 'skipped') skipped++;
      }
    }
  }

  const elapsed = Date.now() - startTime;
  return res.status(200).json({
    success: true, checked, updated, skipped,
    nextOffset: offset + batchSize,
    elapsed_ms: elapsed,
    samples: samples.slice(0, 20)
  });
}

// ACTION: scan-all — Scan ALL shops (not just live_ads=0), recount ad techs
async function actionScanAll(req, res) {
  const batchSize = Math.min(parseInt(req.query.batch) || 200, 500);
  const offset = parseInt(req.query.offset) || 0;
  const startTime = Date.now();
  let updated = 0;
  let checked = 0;
  const samples = [];

  const queryUrl = `${SUPABASE_URL}/rest/v1/shops?select=domain,technologies,live_ads&technologies=not.is.null&order=score.desc.nullslast&limit=${batchSize}&offset=${offset}`;

  const fetchResp = await fetch(queryUrl, {
    headers: HEADERS,
    signal: AbortSignal.timeout(15000)
  });

  if (!fetchResp.ok) {
    const errText = await fetchResp.text();
    return res.status(500).json({ error: `Supabase fetch error: ${fetchResp.status}`, body: errText.slice(0, 500) });
  }

  const shops = await fetchResp.json();
  checked = shops.length;

  if (checked === 0) {
    return res.status(200).json({
      success: true, message: 'No more shops to process',
      checked: 0, updated: 0, offset,
      elapsed_ms: Date.now() - startTime
    });
  }

  const PARALLEL = 20;
  for (let i = 0; i < shops.length; i += PARALLEL) {
    const batch = shops.slice(i, i + PARALLEL);
    if (Date.now() - startTime > 50000) break;

    const promises = batch.map(async (shop) => {
      try {
        const techs = shop.technologies;
        if (!Array.isArray(techs) || techs.length === 0) return 'skipped';

        const result = countAdTechs(techs);
        const newLiveAds = result.count;

        if (newLiveAds !== (shop.live_ads || 0)) {
          const ok = await patchShop(shop.domain, newLiveAds, result.adPlatforms);
          if (ok) {
            samples.push({ domain: shop.domain, old: shop.live_ads, new: newLiveAds, platforms: result.adPlatforms.slice(0, 5) });
            return 'updated';
          }
          return 'error';
        }
        return 'skipped';
      } catch (e) {
        return 'error';
      }
    });

    const results = await Promise.allSettled(promises);
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value === 'updated') updated++;
    }
  }

  return res.status(200).json({
    success: true, checked, updated,
    nextOffset: offset + batchSize,
    elapsed_ms: Date.now() - startTime,
    samples: samples.slice(0, 20)
  });
}

// ACTION: revert — Reset a specific shop's live_ads to 0
async function actionRevert(req, res) {
  const domain = req.query.domain;
  if (!domain) return res.status(400).json({ error: 'Missing domain parameter' });
  const ok = await patchShop(domain, 0, []);
  return res.status(200).json({ success: ok, domain, live_ads: 0 });
}

// ACTION: stats — Show live_ads distribution
async function actionStats(req, res) {
  const countUrl = `${SUPABASE_URL}/rest/v1/shops?live_ads=gt.0&select=domain,live_ads,name,score&order=live_ads.desc&limit=50`;
  const resp = await fetch(countUrl, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
  if (!resp.ok) return res.status(500).json({ error: 'Failed to fetch stats' });
  const topShops = await resp.json();

  const adsCountUrl = `${SUPABASE_URL}/rest/v1/shops?live_ads=gt.0&select=domain&limit=1`;
  const adsResp = await fetch(adsCountUrl, {
    headers: { ...HEADERS, 'Prefer': 'count=exact', 'Range-Unit': 'items', 'Range': '0-0' },
    signal: AbortSignal.timeout(10000)
  });
  let totalWithAds = 'unknown';
  if (adsResp.ok) {
    const range = adsResp.headers.get('content-range');
    if (range) totalWithAds = range.split('/')[1];
  }

  const techCountUrl = `${SUPABASE_URL}/rest/v1/shops?technologies=not.is.null&select=domain&limit=1`;
  const techResp = await fetch(techCountUrl, {
    headers: { ...HEADERS, 'Prefer': 'count=exact', 'Range-Unit': 'items', 'Range': '0-0' },
    signal: AbortSignal.timeout(10000)
  });
  let totalWithTech = 'unknown';
  if (techResp.ok) {
    const range = techResp.headers.get('content-range');
    if (range) totalWithTech = range.split('/')[1];
  }

  return res.status(200).json({
    totalWithTechnologies: totalWithTech,
    totalWithLiveAds: totalWithAds,
    topShops: topShops.map(s => ({ domain: s.domain, name: s.name, live_ads: s.live_ads, score: s.score }))
  });
}

// ACTION: enrich-storeleads — Fetch from Store Leads and update via PATCH
async function actionEnrichStoreleads(req, res) {
  const STORELEADS_KEY = '0828c887-79f6-45b0-5ea9-e3427cb4';
  const batchSize = Math.min(parseInt(req.query.batch) || 50, 50);
  const offset = parseInt(req.query.offset) || 0;
  const country = req.query.country || 'US';
  const sort = req.query.sort || 'estimated_visits';
  const startTime = Date.now();
  let updated = 0;
  const samples = [];

  let slUrl = `https://storeleads.app/json/api/v1/all/domain?p=shopify&ds=active&sort=-${sort}&limit=${batchSize}&offset=${offset}&c=${country}`;
  const createdAfter = req.query.created_after || '';
  if (createdAfter) slUrl += `&cmin=${createdAfter}`;

  const slResp = await fetch(slUrl, {
    headers: { 'Authorization': `Token ${STORELEADS_KEY}` },
    signal: AbortSignal.timeout(15000)
  });

  if (!slResp.ok) {
    return res.status(500).json({ error: `Store Leads: ${slResp.status}`, body: await slResp.text() });
  }

  const slData = await slResp.json();
  const domains = slData.domains || [];

  const PARALLEL = 10;
  for (let i = 0; i < domains.length; i += PARALLEL) {
    const batch = domains.slice(i, i + PARALLEL);
    if (Date.now() - startTime > 50000) break;

    const promises = batch.map(async (d) => {
      const result = countAdTechs((d.technologies || []).map(t => typeof t === 'string' ? t : JSON.stringify(t)));
      let liveAds = d.facebook_ad_count || d.ad_count || d.facebook_ads || d.live_ads || 0;
      if (liveAds === 0) liveAds = result.count;

      if (liveAds > 0) {
        const ok = await patchShop(d.name, liveAds, result.adPlatforms);
        if (ok) {
          samples.push({ domain: d.name, live_ads: liveAds, platforms: result.adPlatforms.slice(0, 3) });
          return 'updated';
        }
      }
      return 'skipped';
    });

    const results = await Promise.allSettled(promises);
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value === 'updated') updated++;
    }
  }

  return res.status(200).json({
    success: true, checked: domains.length, updated,
    nextOffset: offset + batchSize,
    elapsed_ms: Date.now() - startTime,
    samples: samples.slice(0, 20)
  });
}

// ACTION: full-enrich — Fetch top shops from Store Leads with ALL fields and do full PATCH
async function actionFullEnrich(req, res) {
  const STORELEADS_KEY = '0828c887-79f6-45b0-5ea9-e3427cb4';
  const batchSize = Math.min(parseInt(req.query.batch) || 50, 50);
  const offset = parseInt(req.query.offset) || 0;
  const country = req.query.country || 'US';
  const sort = req.query.sort || 'estimated_visits';
  const startTime = Date.now();
  let updated = 0;
  const samples = [];

  let slUrl = `https://storeleads.app/json/api/v1/all/domain?p=shopify&ds=active&sort=-${sort}&limit=${batchSize}&offset=${offset}&c=${country}`;

  const slResp = await fetch(slUrl, {
    headers: { 'Authorization': `Token ${STORELEADS_KEY}` },
    signal: AbortSignal.timeout(15000)
  });

  if (!slResp.ok) {
    return res.status(500).json({ error: `Store Leads: ${slResp.status}`, body: await slResp.text() });
  }

  const slData = await slResp.json();
  const domains = slData.domains || [];

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
    return 'General';
  }

  const PARALLEL = 10;
  for (let i = 0; i < domains.length; i += PARALLEL) {
    const batch = domains.slice(i, i + PARALLEL);
    if (Date.now() - startTime > 50000) break;

    const promises = batch.map(async (d) => {
      try {
        const techs = (d.technologies || []).map(t => typeof t === 'string' ? t : JSON.stringify(t));
        const result = countAdTechs(techs);
        let liveAds = d.facebook_ad_count || d.ad_count || d.facebook_ads || d.live_ads || 0;
        if (liveAds === 0) liveAds = result.count;

        const catStr = Array.isArray(d.categories) ? d.categories.join(',') : '';

        const body = {
          live_ads: liveAds,
          ad_platforms: result.adPlatforms.length > 0 ? result.adPlatforms : (d.ad_platforms || []),
          technologies: techs,
          visitor_countries: d.visitor_countries || [],
          traffic_trend: d.traffic_trend || [],
          monthly_visits: d.estimated_visits || 0,
          estimated_sales: d.estimated_sales || 0,
          estimated_sales_yearly: d.estimated_sales_yearly || 0,
          products_count: d.product_count || 0,
          platform_rank: d.platform_rank || 999999,
          global_rank: d.rank,
          rank_percentile: d.rank_percentile,
          avg_price_usd: d.avg_price_usd,
          monthly_app_spend: d.monthly_app_spend,
          employee_count: d.employee_count,
          apps: Array.isArray(d.apps) ? d.apps : [],
          categories: Array.isArray(d.categories) ? d.categories : [],
          niche: detectNiche(catStr),
          ships_to: d.ships_to_countries || [],
          strategies: d.strategies || [],
          description: d.description,
          city: d.city,
          region: d.region,
          icon: d.icon,
          theme: d.theme?.name || d.theme || null,
          currency: d.currency_code || null,
          language: d.language_code || null,
          shopify_plan: d.plan || null,
          storeleads_updated_at: d.last_updated_at,
          last_scraped: new Date().toISOString()
        };

        const url = `${SUPABASE_URL}/rest/v1/shops?domain=eq.${encodeURIComponent(d.name)}`;
        const resp = await fetch(url, {
          method: 'PATCH',
          headers: HEADERS,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000)
        });

        if (resp.ok) {
          samples.push({
            domain: d.name, live_ads: liveAds,
            traffic: `${(d.traffic_trend || []).length} pts`,
            visitors: `${(d.visitor_countries || []).length} countries`,
            techs: techs.length
          });
          return 'updated';
        }
        return 'error';
      } catch (e) {
        return 'error';
      }
    });

    const results = await Promise.allSettled(promises);
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value === 'updated') updated++;
    }
  }

  return res.status(200).json({
    success: true, checked: domains.length, updated,
    nextOffset: offset + batchSize,
    elapsed_ms: Date.now() - startTime,
    samples: samples.slice(0, 20)
  });
}

// ═══════════════════════════════════════════════════════════
// META GRAPH API — Free, rate-limited (200 calls/hour)
// Used for: ad count + top ads enrichment
// Cache: 72h in Supabase to minimize API calls
// ═══════════════════════════════════════════════════════════

const GRAPH_API = 'https://graph.facebook.com/v21.0';
const CACHE_TTL_HOURS = 72; // 3 days cache

// ─── Save daily snapshot to shop_ads_history (upsert per domain+date) ───
async function saveAdsHistory(domain, liveAds) {
  if (!liveAds || liveAds <= 0) return;
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  try {
    // Upsert: if row exists for this domain+date, update; else insert
    const checkUrl = `${SUPABASE_URL}/rest/v1/shop_ads_history?domain=eq.${encodeURIComponent(domain)}&recorded_at=eq.${today}&select=id`;
    const checkResp = await fetch(checkUrl, { headers: HEADERS, signal: AbortSignal.timeout(3000) });
    if (checkResp.ok) {
      const existing = await checkResp.json();
      if (existing.length > 0) {
        // Update existing row
        await fetch(`${SUPABASE_URL}/rest/v1/shop_ads_history?id=eq.${existing[0].id}`, {
          method: 'PATCH', headers: HEADERS,
          body: JSON.stringify({ live_ads: liveAds }),
          signal: AbortSignal.timeout(3000)
        }).catch(() => {});
      } else {
        // Insert new row
        await fetch(`${SUPABASE_URL}/rest/v1/shop_ads_history`, {
          method: 'POST', headers: { ...HEADERS, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ domain, live_ads: liveAds, recorded_at: today, source: 'meta-graph' }),
          signal: AbortSignal.timeout(3000)
        }).catch(() => {});
      }
    }
  } catch (e) { /* history save is best-effort, don't block main flow */ }
}

// ─── Count active ads for a search term via Meta Graph API ───
// Returns count (number) or { count, source, ... } if debug=true
async function metaCountAds(accessToken, searchTerm, debug = false) {
  if (!accessToken) {
    if (debug) return { count: 0, source: 'none', error: 'META_USER_TOKEN not set' };
    return 0;
  }

  const params = new URLSearchParams({
    access_token: accessToken,
    search_terms: searchTerm,
    ad_reached_countries: '["US","GB","FR","DE","ES","IT","CA","AU"]',
    ad_type: 'ALL',
    ad_active_status: 'ACTIVE',
    fields: 'id',
    limit: '500'
  });

  try {
    let totalCount = 0;
    let pages = 0;
    const MAX_PAGES = 20; // Max 10,000 ads (20 × 500)
    let nextUrl = `${GRAPH_API}/ads_archive?${params}`;

    while (nextUrl && pages < MAX_PAGES) {
      const response = await fetch(nextUrl, {
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        if (debug) return { count: totalCount, source: 'meta-graph', error: `HTTP ${response.status}`, body: errText.slice(0, 500), pages };
        return totalCount;
      }

      const data = await response.json();
      const pageCount = (data.data || []).length;
      totalCount += pageCount;
      pages++;

      // Follow pagination if more results exist
      nextUrl = (data.paging && data.paging.next) ? data.paging.next : null;

      // If this page returned fewer than limit, we're done
      if (pageCount < 500) break;
    }

    if (debug) return { count: totalCount, source: 'meta-graph', pages, search_terms: searchTerm };
    return totalCount;
  } catch (e) {
    if (debug) return { count: 0, source: 'meta-graph', error: e.message };
    return 0;
  }
}

// ─── Fetch top ads with creative data via Meta Graph API ───
// Returns array of ad objects with creative details
async function metaFetchTopAds(accessToken, searchTerm, maxAds = 50) {
  if (!accessToken) return [];

  const params = new URLSearchParams({
    access_token: accessToken,
    search_terms: searchTerm,
    ad_reached_countries: '["US","GB","FR","DE","ES","IT","CA","AU"]',
    ad_type: 'ALL',
    ad_active_status: 'ACTIVE',
    fields: 'id,ad_snapshot_url,ad_creative_bodies,ad_creative_link_titles,ad_creative_link_captions,ad_delivery_start_time,page_name,publisher_platform,ad_creative_link_descriptions,impressions,spend',
    limit: String(Math.min(maxAds, 500))
  });

  try {
    const response = await fetch(`${GRAPH_API}/ads_archive?${params}`, {
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) return [];

    const data = await response.json();
    const items = data.data || [];

    return items.map(item => ({
      ad_id: item.id || '',
      page_name: item.page_name || '',
      body: (item.ad_creative_bodies || [])[0] || '',
      title: (item.ad_creative_link_titles || [])[0] || '',
      caption: (item.ad_creative_link_captions || [])[0] || '',
      description: (item.ad_creative_link_descriptions || [])[0] || '',
      snapshot_url: item.ad_snapshot_url || '',
      start_date: item.ad_delivery_start_time || '',
      platforms: item.publisher_platform || [],
      impressions: item.impressions || null,
      spend: item.spend || null
    })).filter(ad => ad.ad_id);
  } catch (e) {
    return [];
  }
}

// ─── Enrich a shop with Meta Graph API: count + top 5 viral ads ───
async function enrichShopMeta(accessToken, domain) {
  const cleanDomain = domain.replace(/^www\./, '');
  const searchTerm = cleanDomain.replace(/\.(com|fr|de|co\.uk|es|it|io|shop|store|net|org)$/i, '');

  // Step 1: Get ad count
  let count = await metaCountAds(accessToken, searchTerm);
  if (count === 0 && searchTerm !== cleanDomain) {
    count = await metaCountAds(accessToken, cleanDomain);
  }

  // Step 2: Get top ads with creative data
  let ads = await metaFetchTopAds(accessToken, searchTerm, 50);
  if (ads.length === 0 && searchTerm !== cleanDomain) {
    ads = await metaFetchTopAds(accessToken, cleanDomain, 50);
  }

  // Use ads count from actual results if higher
  if (ads.length > count) count = ads.length;

  // Sort by start_date ascending (oldest first = longest running = most viral)
  const sortedAds = ads
    .sort((a, b) => {
      const da = a.start_date ? new Date(a.start_date).getTime() : Infinity;
      const db = b.start_date ? new Date(b.start_date).getTime() : Infinity;
      return da - db;
    });

  // Take top 5 longest-running (most successful) ads
  const topAds = sortedAds.slice(0, 5).map(ad => ({
    ad_id: ad.ad_id,
    body: (ad.body || '').slice(0, 500),
    title: (ad.title || '').slice(0, 200),
    caption: ad.caption || '',
    snapshot_url: ad.snapshot_url,
    start_date: ad.start_date,
    platforms: ad.platforms,
    page_name: ad.page_name
  }));

  // Step 3: Update Supabase
  const now = new Date().toISOString();
  const patchData = {
    live_ads: count,
    live_ads_updated: now
  };
  if (topAds.length > 0) {
    patchData.top_ads = topAds;
    patchData.top_ads_updated = now;
  }

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/shops?domain=eq.${encodeURIComponent(domain)}`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify(patchData),
      signal: AbortSignal.timeout(5000)
    });
  } catch (e) { /* non-blocking */ }

  return { count, topAds, totalScraped: ads.length };
}

// ACTION: meta-sync — Batch sync shops via Meta Graph API
// Processes shops in order of score, with rate limit detection
async function actionMetaSync(req, res) {
  const accessToken = process.env.META_USER_TOKEN || '';
  if (!accessToken) {
    return res.status(500).json({ error: 'META_USER_TOKEN not configured' });
  }

  const batchSize = Math.min(parseInt(req.query.batch) || 10, 200);
  const offset = parseInt(req.query.offset) || 0;
  const force = req.query.force === 'true';
  const orderBy = req.query.order || 'score';
  const withTopAds = req.query.top_ads === 'true'; // Also fetch top ads (slower)
  const startTime = Date.now();
  let updated = 0;
  let checked = 0;
  const samples = [];

  const orderClause = orderBy === 'visits'
    ? 'monthly_visits.desc.nullslast'
    : 'score.desc.nullslast';

  // Fetch shops: if force=true, get all; otherwise only not recently synced
  let queryUrl;
  if (force) {
    queryUrl = `${SUPABASE_URL}/rest/v1/shops?select=domain,name,live_ads,score,monthly_visits&order=${orderClause}&limit=${batchSize}&offset=${offset}`;
  } else {
    // Get shops where live_ads_updated is null OR older than 72h
    const cutoff = new Date(Date.now() - CACHE_TTL_HOURS * 60 * 60 * 1000).toISOString();
    queryUrl = `${SUPABASE_URL}/rest/v1/shops?select=domain,name,live_ads,score,monthly_visits&or=(live_ads_updated.is.null,live_ads_updated.lt.${cutoff})&order=${orderClause}&limit=${batchSize}&offset=${offset}`;
  }

  const fetchResp = await fetch(queryUrl, {
    headers: HEADERS,
    signal: AbortSignal.timeout(10000)
  });

  if (!fetchResp.ok) {
    return res.status(500).json({ error: `Supabase fetch error: ${fetchResp.status}` });
  }

  const shops = await fetchResp.json();
  checked = shops.length;

  if (checked === 0) {
    return res.status(200).json({
      success: true, message: 'No more shops to process',
      checked: 0, updated: 0, offset, elapsed_ms: Date.now() - startTime
    });
  }

  // Process: 3 parallel for count-only, 1 sequential for top_ads (heavier)
  const PARALLEL = withTopAds ? 1 : Math.min(parseInt(req.query.parallel) || 3, 5);
  let rateLimited = false;

  for (let i = 0; i < shops.length; i += PARALLEL) {
    if (Date.now() - startTime > 250000) break; // 250s budget (max 300s)
    if (rateLimited) break;

    const chunk = shops.slice(i, i + PARALLEL);
    const results = await Promise.allSettled(chunk.map(async (shop) => {
      const domain = shop.domain.replace(/^www\./, '');
      const searchTerm = domain.replace(/\.(com|fr|de|co\.uk|es|it|io|shop|store|net|org)$/i, '');

      if (withTopAds) {
        // Full enrichment: count + top ads
        const result = await enrichShopMeta(accessToken, shop.domain);
        return { domain: shop.domain, old: shop.live_ads || 0, new: result.count, ok: true, topAds: result.topAds.length };
      }

      // Count only (faster)
      let count = await metaCountAds(accessToken, searchTerm);

      // Detect rate limit
      if (count === 0) {
        const check = await metaCountAds(accessToken, searchTerm, true);
        if (check.error && (check.error.includes('400') || check.error.includes('429') || check.error.includes('613'))) {
          rateLimited = true;
          return { domain: shop.domain, old: shop.live_ads || 0, new: -1, ok: false, rateLimited: true };
        }
      }

      if (count === 0 && searchTerm !== domain) {
        count = await metaCountAds(accessToken, domain);
      }

      const now = new Date().toISOString();
      const url = `${SUPABASE_URL}/rest/v1/shops?domain=eq.${encodeURIComponent(shop.domain)}`;
      const resp = await fetch(url, {
        method: 'PATCH',
        headers: HEADERS,
        body: JSON.stringify({ live_ads: count, live_ads_updated: now }),
        signal: AbortSignal.timeout(5000)
      });

      // Save daily snapshot for history chart
      if (count > 0) saveAdsHistory(shop.domain, count);

      return { domain: shop.domain, old: shop.live_ads || 0, new: count, ok: resp.ok };
    }));

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.ok) {
        samples.push({ domain: r.value.domain, old: r.value.old, new: r.value.new, topAds: r.value.topAds || 0 });
        if (r.value.new !== r.value.old) updated++;
      } else if (r.status === 'rejected') {
        samples.push({ domain: '?', error: r.reason?.message || 'unknown' });
      }
    }

    // Small delay between batches to respect rate limits (200/h = 1 every 18s, but burst OK)
    if (!rateLimited && i + PARALLEL < shops.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  return res.status(200).json({
    success: true,
    checked,
    updated,
    rateLimited,
    nextOffset: offset + batchSize,
    elapsed_ms: Date.now() - startTime,
    hint: `Next: /api/backfill-ads?action=meta-sync&batch=${batchSize}&offset=${offset + batchSize}${force ? '&force=true' : ''}&order=${orderBy}${withTopAds ? '&top_ads=true' : ''}`,
    samples: samples.slice(0, 30)
  });
}

// ACTION: live-lookup — Real-time Meta Ad Library lookup for a list of domains
// Called from the dashboard when shops are displayed but have no live_ads data
// Uses 72h Supabase cache to minimize Meta API calls
async function actionLiveLookup(req, res) {
  const accessToken = process.env.META_USER_TOKEN || '';
  if (!accessToken) {
    return res.status(500).json({ error: 'META_USER_TOKEN not configured' });
  }

  const domainsParam = req.query.domains || '';
  if (!domainsParam) {
    return res.status(400).json({ error: 'Missing domains parameter (comma-separated)' });
  }

  const domains = domainsParam.split(',').map(d => d.trim()).filter(Boolean).slice(0, 20);
  const startTime = Date.now();
  const results = {};
  const sources = {};
  let rateLimited = false;

  // ─── Step 1: Check Supabase cache (72h TTL) ───
  const domainFilter = domains.map(d => `"${d}"`).join(',');
  try {
    const cacheUrl = `${SUPABASE_URL}/rest/v1/shops?domain=in.(${domainFilter})&select=domain,live_ads,live_ads_updated`;
    const cacheResp = await fetch(cacheUrl, { headers: HEADERS, signal: AbortSignal.timeout(4000) });
    if (cacheResp.ok) {
      const cached = await cacheResp.json();
      const now = Date.now();
      for (const row of cached) {
        if (row.live_ads != null && row.live_ads_updated) {
          const ageHours = (now - new Date(row.live_ads_updated).getTime()) / (1000 * 60 * 60);
          if (ageHours < CACHE_TTL_HOURS) {
            results[row.domain] = row.live_ads;
            sources[row.domain] = 'cache';
          }
        }
      }
    }
  } catch (e) { /* cache miss → proceed to live lookup */ }

  // ─── Step 2: For uncached domains, query Meta Graph API ───
  const needLookup = domains.filter(d => results[d] === undefined);

  if (needLookup.length > 0) {
    const batch = needLookup.slice(0, 10); // Max 10 live lookups per request

    for (const domain of batch) {
      if (rateLimited) break;
      if (Date.now() - startTime > 25000) break; // 25s budget

      const cleanDomain = domain.replace(/^www\./, '');
      const searchTerm = cleanDomain.replace(/\.(com|fr|de|co\.uk|es|it|io|shop|store|net|org)$/i, '');

      let count = await metaCountAds(accessToken, searchTerm);

      // Detect rate limit
      if (count === 0) {
        const check = await metaCountAds(accessToken, searchTerm, true);
        if (check.error && (check.error.includes('400') || check.error.includes('429') || check.error.includes('613'))) {
          rateLimited = true;
          break;
        }
      }

      if (count === 0 && searchTerm !== cleanDomain) {
        count = await metaCountAds(accessToken, cleanDomain);
      }

      results[domain] = count;
      sources[domain] = 'meta-graph';

      // Cache in Supabase
      const now = new Date().toISOString();
      fetch(`${SUPABASE_URL}/rest/v1/shops?domain=eq.${encodeURIComponent(domain)}`, {
        method: 'PATCH',
        headers: HEADERS,
        body: JSON.stringify({ live_ads: count, live_ads_updated: now }),
        signal: AbortSignal.timeout(5000)
      }).catch(() => {});

      // Save daily snapshot for history chart
      if (count > 0) saveAdsHistory(domain, count);

      // Small delay between lookups
      if (batch.indexOf(domain) < batch.length - 1) {
        await new Promise(r => setTimeout(r, 300));
      }
    }
  }

  return res.status(200).json({
    success: true,
    results,
    sources,
    count: domains.length,
    from_cache: Object.values(sources).filter(s => s === 'cache').length,
    lookup_source: 'meta-graph',
    rate_limited: rateLimited,
    elapsed_ms: Date.now() - startTime
  });
}

// ACTION: ads-history — Get historical ad count data for a shop (for chart)
// Returns daily snapshots: [{recorded_at, live_ads}, ...]
async function actionAdsHistory(req, res) {
  const domain = req.query.domain || '';
  if (!domain) return res.status(400).json({ error: 'Missing domain parameter' });

  const range = req.query.range || '6m'; // 3m, 6m, 1y, all
  let daysBack = 180;
  if (range === '3m') daysBack = 90;
  else if (range === '1y') daysBack = 365;
  else if (range === 'all') daysBack = 3650;

  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  try {
    const url = `${SUPABASE_URL}/rest/v1/shop_ads_history?domain=eq.${encodeURIComponent(domain)}&recorded_at=gte.${since}&select=recorded_at,live_ads&order=recorded_at.asc`;
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return res.status(500).json({ error: `Supabase error: ${resp.status}` });

    const history = await resp.json();

    // Also get current live_ads from shops table
    const shopUrl = `${SUPABASE_URL}/rest/v1/shops?domain=eq.${encodeURIComponent(domain)}&select=live_ads,live_ads_updated`;
    const shopResp = await fetch(shopUrl, { headers: HEADERS, signal: AbortSignal.timeout(3000) });
    const shopData = shopResp.ok ? await shopResp.json() : [];
    const current = shopData[0] || {};

    return res.status(200).json({
      success: true,
      domain,
      range,
      current_live_ads: current.live_ads || 0,
      last_updated: current.live_ads_updated || null,
      history,
      data_points: history.length
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ACTION: trustpilot — Scrape Trustpilot rating and review count
// Caches results in shop_trustpilot table with 24h TTL
async function actionTrustpilot(req, res) {
  const domain = req.query.domain || '';
  if (!domain) return res.status(400).json({ error: 'Missing domain parameter' });

  const startTime = Date.now();

  try {
    // Check Supabase cache first (24h TTL)
    const cacheUrl = `${SUPABASE_URL}/rest/v1/shop_trustpilot?domain=eq.${encodeURIComponent(domain)}&select=domain,rating,review_count,updated_at`;
    const cacheResp = await fetch(cacheUrl, { headers: HEADERS, signal: AbortSignal.timeout(3000) });

    if (cacheResp.ok) {
      const cached = await cacheResp.json();
      if (cached && cached.length > 0) {
        const row = cached[0];
        const ageHours = (Date.now() - new Date(row.updated_at).getTime()) / (1000 * 60 * 60);
        if (ageHours < 24) {
          return res.status(200).json({
            success: true,
            domain,
            rating: row.rating,
            review_count: row.review_count,
            source: 'cache',
            cached_age_hours: ageHours.toFixed(1),
            elapsed_ms: Date.now() - startTime
          });
        }
      }
    }

    // Cache miss or stale — fetch from Trustpilot
    const trustpilotUrl = `https://www.trustpilot.com/review/${domain}`;
    const fetchResp = await fetch(trustpilotUrl, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Peekr/1.0; +https://peekr.app)' }
    });

    if (!fetchResp.ok) {
      return res.status(404).json({
        success: false,
        error: `Trustpilot page not found for ${domain}`,
        status: fetchResp.status,
        elapsed_ms: Date.now() - startTime
      });
    }

    const html = await fetchResp.text();

    // Try to extract JSON-LD structured data first
    let rating = null;
    let reviewCount = null;

    const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
    if (jsonLdMatch) {
      try {
        const jsonLdData = JSON.parse(jsonLdMatch[1]);

        // Handle different JSON-LD formats
        const findAggregateRating = (obj) => {
          if (!obj) return null;
          if (obj.aggregateRating) {
            return {
              rating: parseFloat(obj.aggregateRating.ratingValue),
              count: parseInt(obj.aggregateRating.reviewCount, 10)
            };
          }
          if (obj['@graph']) {
            for (const item of obj['@graph']) {
              const result = findAggregateRating(item);
              if (result) return result;
            }
          }
          return null;
        };

        const result = findAggregateRating(jsonLdData);
        if (result) {
          rating = result.rating;
          reviewCount = result.count;
        }
      } catch (e) {
        // JSON-LD parse error, fall through to regex
      }
    }

    // Fallback: try regex patterns if JSON-LD failed
    if (rating === null || reviewCount === null) {
      // Look for rating in common HTML patterns
      const ratingMatch = html.match(/rating["\s:]*([0-9.]+)/i) || html.match(/stars["\s:]*([0-9.]+)/i);
      if (ratingMatch) rating = parseFloat(ratingMatch[1]);

      // Look for review count patterns like "3,241 reviews" or "3241 reviews"
      const countMatch = html.match(/([0-9,]+)\s*reviews/i) || html.match(/"reviewCount"\s*:\s*([0-9]+)/i);
      if (countMatch) {
        reviewCount = parseInt(countMatch[1].replace(/,/g, ''), 10);
      }
    }

    // If we couldn't find either value, return error
    if (rating === null && reviewCount === null) {
      return res.status(400).json({
        success: false,
        error: `Could not extract Trustpilot data for ${domain}`,
        hint: 'Domain may not have Trustpilot page or page format changed',
        elapsed_ms: Date.now() - startTime
      });
    }

    // Store in Supabase cache
    const now = new Date().toISOString();
    const upsertUrl = `${SUPABASE_URL}/rest/v1/shop_trustpilot`;

    // Try upsert: check if exists first
    const checkExist = await fetch(`${SUPABASE_URL}/rest/v1/shop_trustpilot?domain=eq.${encodeURIComponent(domain)}&select=domain`, { headers: HEADERS, signal: AbortSignal.timeout(2000) }).catch(() => null);

    if (checkExist?.ok) {
      const existing = await checkExist.json().catch(() => []);
      if (existing && existing.length > 0) {
        // UPDATE
        await fetch(`${upsertUrl}?domain=eq.${encodeURIComponent(domain)}`, {
          method: 'PATCH',
          headers: HEADERS,
          body: JSON.stringify({ rating, review_count: reviewCount, updated_at: now }),
          signal: AbortSignal.timeout(3000)
        }).catch(() => {});
      } else {
        // INSERT
        await fetch(upsertUrl, {
          method: 'POST',
          headers: { ...HEADERS, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ domain, rating, review_count: reviewCount, updated_at: now }),
          signal: AbortSignal.timeout(3000)
        }).catch(() => {});
      }
    }

    return res.status(200).json({
      success: true,
      domain,
      rating: rating !== null ? rating : undefined,
      review_count: reviewCount !== null ? reviewCount : undefined,
      source: 'live',
      elapsed_ms: Date.now() - startTime
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: e.message,
      domain,
      elapsed_ms: Date.now() - startTime
    });
  }
}

// ACTION: ad-creatives — Fetch detailed ad creatives from Meta Ad Library
// Returns rich ad data with creative bodies, impressions, spend, etc.
async function actionAdCreatives(req, res) {
  const accessToken = process.env.META_USER_TOKEN || '';
  if (!accessToken) {
    return res.status(500).json({ error: 'META_USER_TOKEN not configured' });
  }

  const domain = req.query.domain || '';
  if (!domain) return res.status(400).json({ error: 'Missing domain parameter' });

  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const startTime = Date.now();

  try {
    const cleanDomain = domain.replace(/^www\./, '');
    const searchTerm = cleanDomain.replace(/\.(com|fr|de|co\.uk|es|it|io|shop|store|net|org)$/i, '');

    const params = new URLSearchParams({
      access_token: accessToken,
      search_terms: searchTerm,
      ad_reached_countries: 'US',
      ad_type: 'ALL',
      ad_active_status: 'ACTIVE',
      fields: 'ad_creative_bodies,ad_creative_link_titles,ad_creative_link_descriptions,ad_snapshot_url,ad_delivery_start_time,page_name,page_id,publisher_platforms,impressions,spend,languages,target_locations',
      limit: String(Math.min(limit, 500))
    });

    const response = await fetch(`${GRAPH_API}/ads_archive?${params}`, {
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return res.status(response.status).json({
        success: false,
        error: `Meta API error: ${response.status}`,
        details: errText.slice(0, 300),
        elapsed_ms: Date.now() - startTime
      });
    }

    const data = await response.json();
    const items = data.data || [];

    // Process and enrich ad data
    const ads = items.slice(0, limit).map(item => {
      // Calculate days active
      let daysActive = 0;
      if (item.ad_delivery_start_time) {
        const startDate = new Date(item.ad_delivery_start_time);
        daysActive = Math.floor((Date.now() - startDate.getTime()) / (1000 * 60 * 60 * 24));
      }

      // Infer media type from snapshot URL
      let mediaType = 'image';
      const snapshotUrl = item.ad_snapshot_url || '';
      if (snapshotUrl.includes('.mp4') || snapshotUrl.includes('.webm')) mediaType = 'video';
      if (snapshotUrl.includes('.gif')) mediaType = 'gif';

      // Parse platforms (publisher_platforms is usually an array)
      const platforms = Array.isArray(item.publisher_platforms)
        ? item.publisher_platforms
        : (typeof item.publisher_platforms === 'string' ? [item.publisher_platforms] : []);

      return {
        ad_id: item.id || '',
        page_name: item.page_name || '',
        page_id: item.page_id || '',
        body: (item.ad_creative_bodies || [])[0] || '',
        title: (item.ad_creative_link_titles || [])[0] || '',
        description: (item.ad_creative_link_descriptions || [])[0] || '',
        snapshot_url: snapshotUrl,
        start_date: item.ad_delivery_start_time || '',
        days_active: daysActive,
        platforms,
        impressions: item.impressions || null,
        spend: item.spend || null,
        languages: item.languages || [],
        target_locations: item.target_locations || [],
        media_type: mediaType
      };
    }).filter(ad => ad.ad_id);

    return res.status(200).json({
      success: true,
      domain,
      ads,
      total: ads.length,
      limit_requested: limit,
      api_version: '21.0',
      elapsed_ms: Date.now() - startTime
    });
  } catch (e) {
    // FALLBACK: If Meta API fails, try Supabase ads table
    try {
      const cleanDomain = domain.replace(/^www\./, '');
      const searchTerm = cleanDomain.replace(/\.(com|fr|de|co\.uk|es|it|io|shop|store|net|org)$/i, '');

      // Try shop_domain first, then page_name
      let sbUrl = `${SUPABASE_URL}/rest/v1/ads?select=id,meta_ad_id,page_name,page_id,ad_creative_body,ad_snapshot_url,ad_delivery_start_time,status,niche,peekr_score,publisher_platforms&order=ad_delivery_start_time.desc.nullslast&limit=${limit}`;
      let sbResp = await fetch(sbUrl + `&shop_domain=ilike.*${encodeURIComponent(searchTerm)}*`, { headers: HEADERS });
      let sbData = await sbResp.json();

      if (!sbData || sbData.length === 0) {
        sbResp = await fetch(sbUrl + `&page_name=ilike.*${encodeURIComponent(searchTerm)}*`, { headers: HEADERS });
        sbData = await sbResp.json();
      }

      if (sbData && sbData.length > 0) {
        const ads = sbData.map(row => ({
          ad_id: row.meta_ad_id || String(row.id),
          page_name: row.page_name || '',
          page_id: row.page_id || '',
          body: row.ad_creative_body || '',
          title: '',
          description: '',
          snapshot_url: row.ad_snapshot_url || '',
          start_date: row.ad_delivery_start_time || '',
          days_active: row.ad_delivery_start_time ? Math.floor((Date.now() - new Date(row.ad_delivery_start_time).getTime()) / (1000 * 60 * 60 * 24)) : 0,
          platforms: row.publisher_platforms || [],
          status: row.status || 'active',
          media_type: 'image'
        }));
        return res.status(200).json({
          success: true,
          domain,
          ads,
          total: ads.length,
          source: 'supabase_fallback',
          elapsed_ms: Date.now() - startTime
        });
      }
    } catch (sbErr) {
      // Both Meta and Supabase failed
    }

    return res.status(500).json({
      success: false,
      error: e.message,
      domain,
      elapsed_ms: Date.now() - startTime
    });
  }
}

// Proxy for product images — avoids CORS issues when fetching Shopify /products.json
async function actionProductImages(req, res) {
  const domainsParam = req.query.domains || '';
  if (!domainsParam) return res.status(400).json({ error: 'Missing domains parameter' });
  const domains = domainsParam.split(',').map(d => d.trim()).filter(Boolean).slice(0, 20);
  const results = {};
  const promises = domains.map(async (domain) => {
    try {
      const resp = await fetch(`https://${domain}/products.json?limit=4&fields=images,title`, {
        signal: AbortSignal.timeout(4000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Peekr/1.0)' }
      });
      if (!resp.ok) { results[domain] = []; return; }
      const data = await resp.json();
      const imgs = (data.products || []).slice(0, 3).map(p => {
        const img = p.images && p.images[0] ? p.images[0].src : '';
        return img ? img.replace(/\.([a-z]+)\?/, '_200x200.$1?') : '';
      }).filter(Boolean);
      results[domain] = imgs;
    } catch (e) {
      results[domain] = [];
    }
  });
  await Promise.allSettled(promises);
  return res.status(200).json({ success: true, results });
}

// ─── Main handler ───
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const action = req.query.action || 'scan';

  try {
    switch (action) {
      case 'scan': return await actionScan(req, res);
      case 'scan-all': return await actionScanAll(req, res);
      case 'revert': return await actionRevert(req, res);
      case 'stats': return await actionStats(req, res);
      case 'enrich': return await actionEnrichStoreleads(req, res);
      case 'full-enrich': return await actionFullEnrich(req, res);
      case 'meta-sync': return await actionMetaSync(req, res);
      case 'live-lookup': return await actionLiveLookup(req, res);
      case 'ads-history': return await actionAdsHistory(req, res);
      case 'trustpilot': return await actionTrustpilot(req, res);
      case 'ad-creatives': return await actionAdCreatives(req, res);
      case 'product-images': return await actionProductImages(req, res);
      case 'meta-debug': {
        const accessToken = process.env.META_USER_TOKEN || '';
        const tokenPreview = accessToken ? accessToken.slice(0, 10) + '...' + accessToken.slice(-5) : 'NOT SET';
        const testTerm = req.query.q || 'gymshark';

        const result = await metaCountAds(accessToken, testTerm, true);

        // Also test top ads fetch
        let topAdsTest = { count: 0 };
        if (accessToken) {
          const ads = await metaFetchTopAds(accessToken, testTerm, 5);
          topAdsTest = { count: ads.length, sample: ads.slice(0, 2) };
        }

        return res.status(200).json({
          meta_token: tokenPreview,
          active_source: 'meta-graph (free, 200 calls/h)',
          cache_ttl: `${CACHE_TTL_HOURS}h`,
          search_term: testTerm,
          count_result: result,
          top_ads_test: topAdsTest
        });
      }
      default: return res.status(400).json({
        error: `Unknown action: ${action}`,
        available: ['scan', 'scan-all', 'revert', 'stats', 'enrich', 'full-enrich', 'meta-sync', 'live-lookup', 'ads-history', 'trustpilot', 'ad-creatives', 'product-images', 'meta-debug']
      });
    }
  } catch (error) {
    return res.status(500).json({ error: error.message, action });
  }
};
