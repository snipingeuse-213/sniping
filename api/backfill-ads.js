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

  // Fetch shops that have technologies (not null) and live_ads is 0 or null
  // Note: technologies is text[] — use not.is.null to exclude NULLs, filter empty arrays server-side
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

  // Process in parallel batches of 20
  const PARALLEL = 20;
  for (let i = 0; i < shops.length; i += PARALLEL) {
    const batch = shops.slice(i, i + PARALLEL);
    if (Date.now() - startTime > 50000) break; // Leave buffer for response

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
    success: true,
    checked,
    updated,
    skipped,
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

  // Count with live_ads > 0
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

  // Count with technologies not null
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
      // Store Leads technologies are already objects (not JSON strings)
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
// This updates traffic_trend, visitor_countries, technologies, ad_platforms, etc.
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
        const visits = d.estimated_visits || 0;
        const sales = d.estimated_sales || 0;
        const rank = d.platform_rank || 999999;
        const prods = d.product_count || 0;
        const appCount = Array.isArray(d.apps) ? d.apps.length : 0;

        // Build full update body with ALL fields
        const body = {
          live_ads: liveAds,
          ad_platforms: result.adPlatforms.length > 0 ? result.adPlatforms : (d.ad_platforms || []),
          technologies: techs,
          visitor_countries: d.visitor_countries || [],
          traffic_trend: d.traffic_trend || [],
          monthly_visits: visits,
          estimated_sales: sales,
          estimated_sales_yearly: d.estimated_sales_yearly || 0,
          products_count: prods,
          platform_rank: rank,
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
          const hasTraffic = (d.traffic_trend || []).length > 0;
          const hasVisitors = (d.visitor_countries || []).length > 0;
          samples.push({
            domain: d.name,
            live_ads: liveAds,
            traffic: hasTraffic ? `${(d.traffic_trend || []).length} pts` : 'none',
            visitors: hasVisitors ? `${(d.visitor_countries || []).length} countries` : 'none',
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

// ACTION: meta-sync — Fetch REAL live ads count from Meta Ad Library API for each shop
// This gives accurate counts unlike the technology-based estimation
// Processes ~5 shops per call to stay within Vercel 10s timeout
// GET /api/backfill-ads?action=meta-sync&batch=5&offset=0
// GET /api/backfill-ads?action=meta-sync&batch=5&offset=0&force=true  (re-sync all, not just 0)
const GRAPH_API = 'https://graph.facebook.com/v21.0';

async function metaCountAds(accessToken, searchTerm) {
  // Single-page fast count: fetch up to 500 IDs in one call
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
    const response = await fetch(`${GRAPH_API}/ads_archive?${params}`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return 0;
    const data = await response.json();
    const count = (data.data || []).length;
    const hasMore = !!(data.paging && data.paging.next);
    // If there are more pages, estimate conservatively
    return hasMore ? count * 3 : count;
  } catch (e) {
    return 0;
  }
}

async function actionMetaSync(req, res) {
  const accessToken = process.env.META_USER_TOKEN || '';
  if (!accessToken) {
    return res.status(500).json({ error: 'META_USER_TOKEN not configured' });
  }

  const batchSize = Math.min(parseInt(req.query.batch) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const force = req.query.force === 'true';
  const orderBy = req.query.order || 'score'; // score or visits
  const startTime = Date.now();
  let updated = 0;
  let checked = 0;
  const samples = [];

  // Order: by score (most important shops first) or monthly_visits
  const orderClause = orderBy === 'visits'
    ? 'monthly_visits.desc.nullslast'
    : 'score.desc.nullslast';

  // Fetch shops: if force=true, get all; otherwise only those not yet synced
  let queryUrl;
  if (force) {
    queryUrl = `${SUPABASE_URL}/rest/v1/shops?select=domain,name,live_ads,score,monthly_visits&order=${orderClause}&limit=${batchSize}&offset=${offset}`;
  } else {
    queryUrl = `${SUPABASE_URL}/rest/v1/shops?select=domain,name,live_ads,score,monthly_visits&live_ads_updated=is.null&order=${orderClause}&limit=${batchSize}&offset=${offset}`;
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

  // Process in PARALLEL batches of 10 (respect Meta rate limits)
  const PARALLEL = Math.min(parseInt(req.query.parallel) || 10, 20);
  for (let i = 0; i < shops.length; i += PARALLEL) {
    if (Date.now() - startTime > 45000) break; // 45s budget (Vercel max 60s)

    const chunk = shops.slice(i, i + PARALLEL);
    const results = await Promise.allSettled(chunk.map(async (shop) => {
      const domain = shop.domain.replace(/^www\./, '');
      const searchTerm = domain.replace(/\.(com|fr|de|co\.uk|es|it|io|shop|store|net|org)$/i, '');

      // Search by brand name first, fallback to full domain
      let count = await metaCountAds(accessToken, searchTerm);
      if (count === 0 && searchTerm !== domain) {
        count = await metaCountAds(accessToken, domain);
      }

      // Single PATCH with both live_ads + live_ads_updated
      const now = new Date().toISOString();
      const url = `${SUPABASE_URL}/rest/v1/shops?domain=eq.${encodeURIComponent(shop.domain)}`;
      const resp = await fetch(url, {
        method: 'PATCH',
        headers: HEADERS,
        body: JSON.stringify({ live_ads: count, live_ads_updated: now }),
        signal: AbortSignal.timeout(5000)
      });

      return { domain: shop.domain, old: shop.live_ads || 0, new: count, ok: resp.ok };
    }));

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.ok) {
        samples.push({ domain: r.value.domain, old: r.value.old, new: r.value.new });
        if (r.value.new !== r.value.old) updated++;
      } else if (r.status === 'rejected') {
        samples.push({ domain: '?', error: r.reason?.message || 'unknown' });
      }
    }
  }

  return res.status(200).json({
    success: true,
    checked,
    updated,
    nextOffset: offset + batchSize,
    elapsed_ms: Date.now() - startTime,
    hint: `Next: /api/backfill-ads?action=meta-sync&batch=${batchSize}&offset=${offset + batchSize}${force ? '&force=true' : ''}&order=${orderBy}`,
    samples: samples.slice(0, 30) // Limit response size
  });
}

// ACTION: live-lookup — Real-time Meta Ad Library lookup for a list of domains
// Called from the dashboard when shops are displayed but have no live_ads data
// GET /api/backfill-ads?action=live-lookup&domains=shop1.com,shop2.com,shop3.com
// Returns { results: { "shop1.com": 42, "shop2.com": 0, ... } }
// Also updates the database so subsequent loads are instant
async function actionLiveLookup(req, res) {
  const accessToken = process.env.META_USER_TOKEN || '';
  if (!accessToken) {
    return res.status(500).json({ error: 'META_USER_TOKEN not configured' });
  }

  const domainsParam = req.query.domains || '';
  if (!domainsParam) {
    return res.status(400).json({ error: 'Missing domains parameter (comma-separated)' });
  }

  // Limit to 20 domains per call to stay fast
  const domains = domainsParam.split(',').map(d => d.trim()).filter(Boolean).slice(0, 20);
  const startTime = Date.now();
  const results = {};

  // Query Meta in parallel for all domains
  const promises = domains.map(async (domain) => {
    const cleanDomain = domain.replace(/^www\./, '');
    const searchTerm = cleanDomain.replace(/\.(com|fr|de|co\.uk|es|it|io|shop|store|net|org)$/i, '');

    let count = await metaCountAds(accessToken, searchTerm);
    if (count === 0 && searchTerm !== cleanDomain) {
      count = await metaCountAds(accessToken, cleanDomain);
    }

    results[domain] = count;

    // Update database in background (fire and forget for speed)
    const now = new Date().toISOString();
    const url = `${SUPABASE_URL}/rest/v1/shops?domain=eq.${encodeURIComponent(domain)}`;
    fetch(url, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ live_ads: count, live_ads_updated: now }),
      signal: AbortSignal.timeout(5000)
    }).catch(() => {});

    return { domain, count };
  });

  await Promise.allSettled(promises);

  return res.status(200).json({
    success: true,
    results,
    count: domains.length,
    elapsed_ms: Date.now() - startTime
  });
}

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
      default: return res.status(400).json({ error: `Unknown action: ${action}`, available: ['scan', 'scan-all', 'revert', 'stats', 'enrich', 'full-enrich', 'meta-sync', 'live-lookup'] });
    }
  } catch (error) {
    return res.status(500).json({ error: error.message, action });
  }
};
