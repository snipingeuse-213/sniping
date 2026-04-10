// Peekr — Backfill live_ads by parsing technologies already in DB
// Strategy: Read shops from Supabase, count advertising technologies, PATCH update live_ads
// Uses PATCH (not POST) because POST upsert uses PK not domain unique constraint
//
// Endpoints:
//   GET /api/backfill-ads?action=scan&batch=200&offset=0  — scan DB and update live_ads
//   GET /api/backfill-ads?action=revert&domain=gymshark.com — reset a shop's live_ads
//   GET /api/backfill-ads?action=stats — show current live_ads distribution

const SUPABASE_URL = 'https://vsyceexjsitliwaasdhd.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZzeWNlZXhqc2l0bGl3YWFzZGhkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0NDgzNzYsImV4cCI6MjA5MDAyNDM3Nn0.nng6CrCZIYiW3i-b3z5hm6AXhepA8t1CUhZ1Kt4aZwo';

const HEADERS = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json'
};

// Count advertising technologies in a shop's technologies array
function countAdTechs(technologies) {
  if (!Array.isArray(technologies) || technologies.length === 0) return 0;

  let count = 0;
  const adPlatforms = [];

  for (const tech of technologies) {
    // Technologies can be objects with categories or plain strings
    if (typeof tech === 'object' && tech !== null) {
      const categories = tech.categories || [];
      const name = tech.name || '';

      // Check categories for advertising-related
      const isAd = categories.some(c =>
        /advertising|ad network|ad exchange|retargeting|remarketing|ad server|ad management/i.test(
          typeof c === 'string' ? c : ''
        )
      );

      // Also check by known ad platform names
      const isKnownAdPlatform = /facebook\s*ads|meta\s*ads|google\s*ads|tiktok\s*ads|snapchat\s*ads|pinterest\s*ads|bing\s*ads|microsoft\s*ads|criteo|adroll|taboola|outbrain|amazon\s*ads|facebook\s*pixel|google\s*tag|doubleclick|adsense|adwords/i.test(name);

      if (isAd || isKnownAdPlatform) {
        count++;
        adPlatforms.push(name);
      }
    } else if (typeof tech === 'string') {
      // Plain string tech name
      if (/facebook\s*ads|meta\s*ads|google\s*ads|tiktok\s*ads|snapchat\s*ads|pinterest\s*ads|criteo|adroll|taboola|outbrain|facebook\s*pixel/i.test(tech)) {
        count++;
        adPlatforms.push(tech);
      }
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

// ACTION: scan — Read shops from DB, count ad techs, update live_ads
async function actionScan(req, res) {
  const batchSize = Math.min(parseInt(req.query.batch) || 200, 500);
  const offset = parseInt(req.query.offset) || 0;
  const startTime = Date.now();
  let updated = 0;
  let checked = 0;
  let skipped = 0;
  const samples = [];

  // Fetch shops that have technologies data but live_ads is 0 or null
  // Order by score desc to prioritize important shops first
  const queryUrl = `${SUPABASE_URL}/rest/v1/shops?select=domain,technologies,live_ads&technologies=neq.{}&technologies=neq.[]&or=(live_ads.eq.0,live_ads.is.null)&order=score.desc.nullslast&limit=${batchSize}&offset=${offset}`;

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
      message: 'No more shops to process',
      checked: 0,
      updated: 0,
      offset,
      elapsed_ms: Date.now() - startTime
    });
  }

  // Process in parallel batches of 20
  const PARALLEL = 20;
  for (let i = 0; i < shops.length; i += PARALLEL) {
    const batch = shops.slice(i, i + PARALLEL);

    // Check timeout — leave 5s buffer for response
    if (Date.now() - startTime > 50000) {
      break;
    }

    const promises = batch.map(async (shop) => {
      try {
        const techs = typeof shop.technologies === 'string'
          ? JSON.parse(shop.technologies)
          : shop.technologies;

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

  // Fetch ALL shops that have technologies data, regardless of current live_ads
  const queryUrl = `${SUPABASE_URL}/rest/v1/shops?select=domain,technologies,live_ads&technologies=neq.{}&technologies=neq.[]&order=score.desc.nullslast&limit=${batchSize}&offset=${offset}`;

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
      message: 'No more shops to process',
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
        const techs = typeof shop.technologies === 'string'
          ? JSON.parse(shop.technologies)
          : shop.technologies;

        const result = countAdTechs(techs);
        const newLiveAds = result.count;

        // Only PATCH if the value changed
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
    success: true,
    checked,
    updated,
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
  // Count shops with live_ads > 0
  const countUrl = `${SUPABASE_URL}/rest/v1/shops?live_ads=gt.0&select=domain,live_ads,name,score&order=live_ads.desc&limit=50`;
  const resp = await fetch(countUrl, { headers: HEADERS, signal: AbortSignal.timeout(10000) });

  if (!resp.ok) {
    return res.status(500).json({ error: 'Failed to fetch stats' });
  }

  const topShops = await resp.json();

  // Count total with technologies
  const techCountUrl = `${SUPABASE_URL}/rest/v1/shops?technologies=neq.{}&technologies=neq.[]&select=domain&limit=1`;
  const techResp = await fetch(techCountUrl, {
    headers: { ...HEADERS, 'Prefer': 'count=exact', 'Range-Unit': 'items', 'Range': '0-0' },
    signal: AbortSignal.timeout(10000)
  });

  let totalWithTech = 'unknown';
  if (techResp.ok) {
    const range = techResp.headers.get('content-range');
    if (range) totalWithTech = range.split('/')[1];
  }

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

  // Fetch from Store Leads
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

  // For each domain, count ad techs and PATCH update
  const PARALLEL = 10;
  for (let i = 0; i < domains.length; i += PARALLEL) {
    const batch = domains.slice(i, i + PARALLEL);
    if (Date.now() - startTime > 50000) break;

    const promises = batch.map(async (d) => {
      const result = countAdTechs(d.technologies || []);
      // Also check Store Leads fields
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
    success: true,
    checked: domains.length,
    updated,
    nextOffset: offset + batchSize,
    elapsed_ms: Date.now() - startTime,
    samples: samples.slice(0, 20)
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
      default: return res.status(400).json({ error: `Unknown action: ${action}`, available: ['scan', 'scan-all', 'revert', 'stats', 'enrich'] });
    }
  } catch (error) {
    return res.status(500).json({ error: error.message, action });
  }
};
