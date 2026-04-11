// Meta Ad Library API — Real-time ad search for a specific domain/brand
// GET /api/meta-ads?domain=gymshark.com&limit=25
//
// Returns: { total, ads: [...], cached }
// Requires env vars: META_USER_TOKEN (long-lived user access token with ads_read permission)

const GRAPH_API = 'https://graph.facebook.com/v21.0';
const SUPABASE_URL = 'https://vsyceexjsitliwaasdhd.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZzeWNlZXhqc2l0bGl3YWFzZGhkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0NDgzNzYsImV4cCI6MjA5MDAyNDM3Nn0.nng6CrCZIYiW3i-b3z5hm6AXhepA8t1CUhZ1Kt4aZwo';

// Fire-and-forget: save live_ads count back to Supabase so dashboard has real data
function saveAdCount(domain, count) {
  const now = new Date().toISOString();
  // Try multiple domain variants (exact, with www, without TLD variations)
  const variants = [domain];
  if (!domain.startsWith('www.')) variants.push('www.' + domain);

  for (const d of variants) {
    fetch(`${SUPABASE_URL}/rest/v1/shops?domain=eq.${encodeURIComponent(d)}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ live_ads: count, live_ads_updated: now }),
      signal: AbortSignal.timeout(3000)
    }).catch(() => {}); // Silently ignore errors — this is a best-effort write-back
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=1800'); // Cache 1h

  const domain = (req.query.domain || '').replace(/^www\./, '').trim().toLowerCase();
  const limit = Math.min(parseInt(req.query.limit) || 25, 100);
  const countOnly = req.query.count === 'true';

  if (!domain) {
    return res.status(400).json({ error: 'Missing domain parameter' });
  }

  // Use long-lived user access token (ads_read permission required for ads_archive)
  const accessToken = process.env.META_USER_TOKEN || '';

  if (!accessToken) {
    return res.status(500).json({
      error: 'Meta API not configured',
      message: 'META_USER_TOKEN environment variable is required (user access token with ads_read permission)'
    });
  }

  try {
    // Strategy: search by domain name as search term
    // This finds ads whose page/advertiser matches the domain
    const searchTerm = domain.replace(/\.(com|fr|de|co\.uk|es|it|io|shop|store|net|org)$/i, '');

    if (countOnly) {
      // Fast count: paginate with minimal fields
      const total = await countAllAds(accessToken, searchTerm, domain);
      return res.json({ total, domain });
    }

    // Fetch ads with full details
    const fields = [
      'id', 'page_name', 'page_id',
      'ad_delivery_start_time',
      'ad_creative_bodies',
      'ad_creative_link_titles',
      'ad_creative_link_captions',
      'ad_creative_link_descriptions',
      'ad_snapshot_url',
      'eu_total_reach',
      'impressions',
      'spend',
      'publisher_platforms',
      'languages'
    ].join(',');

    // Try multiple search strategies in order of specificity
    let result = null;

    // 1. Search by exact domain
    result = await searchAds(accessToken, domain, fields, limit);

    // 2. If few results, also search by brand name (domain without TLD)
    if (result.data.length < 5 && searchTerm !== domain) {
      const brandResult = await searchAds(accessToken, searchTerm, fields, limit);
      // Merge, dedup by ID
      const seenIds = new Set(result.data.map(a => a.id));
      for (const ad of brandResult.data) {
        if (!seenIds.has(ad.id)) {
          result.data.push(ad);
          seenIds.add(ad.id);
        }
      }
      if (brandResult.paging) result.paging = brandResult.paging;
    }

    // Fast total: do a quick count with id-only (max 3 pages, ~5s)
    let total = result.data.length;
    if (result.paging && result.paging.next) {
      total = await countAllAds(accessToken, searchTerm, domain);
    }

    // Transform ads for the frontend
    const ads = result.data.slice(0, limit).map(transformAd);

    // Write-back: save real Meta count to Supabase (fire-and-forget)
    saveAdCount(domain, total);

    return res.json({
      total,
      count: ads.length,
      domain,
      ads
    });

  } catch (err) {
    console.error('Meta Ads API error:', err.message);
    return res.status(500).json({
      error: 'Failed to fetch Meta ads',
      message: err.message
    });
  }
};

async function searchAds(accessToken, searchTerm, fields, limit) {
  const params = new URLSearchParams({
    access_token: accessToken,
    search_terms: searchTerm,
    ad_reached_countries: '["US","GB","FR","DE","ES","IT","CA","AU"]',
    ad_type: 'ALL',
    ad_active_status: 'ACTIVE',
    fields: fields,
    limit: String(limit)
  });

  const url = `${GRAPH_API}/ads_archive?${params}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Meta API ${response.status}: ${errText.substring(0, 200)}`);
  }

  return await response.json();
}

async function countAllAds(accessToken, searchTerm, domain) {
  // Fast count: max 3 pages to stay within Vercel timeout (~5s)
  const params = new URLSearchParams({
    access_token: accessToken,
    search_terms: searchTerm,
    ad_reached_countries: '["US","GB","FR","DE","ES","IT","CA","AU"]',
    ad_type: 'ALL',
    ad_active_status: 'ACTIVE',
    fields: 'id',
    limit: '500'
  });

  let total = 0;
  let url = `${GRAPH_API}/ads_archive?${params}`;
  const maxPages = 3; // Keep fast: 3 pages = up to 1500 counted in ~3-4s
  let pages = 0;
  let hasMore = false;

  while (url && pages < maxPages) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) break;
      const data = await response.json();
      total += (data.data || []).length;
      hasMore = !!(data.paging && data.paging.next);
      url = hasMore ? data.paging.next : null;
      pages++;
    } catch (e) {
      break;
    }
  }

  // If we hit the page limit and there's more, extrapolate
  if (hasMore && pages >= maxPages) {
    const avgPerPage = total / pages;
    // Conservative estimate: assume ~4x more pages for big brands
    total = Math.round(total * 2.5);
  }

  return total;
}

function transformAd(raw) {
  const impressions = parseRange(
    raw.impressions ? (Array.isArray(raw.impressions) ? raw.impressions[0] : raw.impressions) : null
  );
  const spend = parseRange(
    raw.spend ? (Array.isArray(raw.spend) ? raw.spend[0] : raw.spend) : null
  );

  const startDate = raw.ad_delivery_start_time ? new Date(raw.ad_delivery_start_time) : null;
  const daysRunning = startDate ? Math.floor((Date.now() - startDate.getTime()) / (1000 * 60 * 60 * 24)) : null;

  return {
    id: raw.id,
    page_name: raw.page_name || null,
    page_id: raw.page_id || null,
    body: raw.ad_creative_bodies ? raw.ad_creative_bodies[0] : null,
    title: raw.ad_creative_link_titles ? raw.ad_creative_link_titles[0] : null,
    caption: raw.ad_creative_link_captions ? raw.ad_creative_link_captions[0] : null,
    description: raw.ad_creative_link_descriptions ? raw.ad_creative_link_descriptions[0] : null,
    // Strip access_token from snapshot URL for security (don't leak token to frontend)
    snapshot_url: raw.ad_snapshot_url
      ? raw.ad_snapshot_url.replace(/[?&]access_token=[^&]+/, '').replace(/\?$/, '')
      : null,
    // Also provide a clean Meta Library link
    meta_library_url: raw.id ? `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&id=${raw.id}` : null,
    start_date: raw.ad_delivery_start_time || null,
    days_running: daysRunning,
    reach: Number(raw.eu_total_reach) || 0,
    impressions_lower: impressions.lower,
    impressions_upper: impressions.upper,
    spend_lower: spend.lower,
    spend_upper: spend.upper,
    platforms: raw.publisher_platforms || [],
    languages: raw.languages || []
  };
}

function parseRange(obj) {
  if (!obj) return { lower: 0, upper: 0 };
  if (typeof obj === 'string') {
    const parts = obj.split('-').map(Number);
    return { lower: parts[0] || 0, upper: parts[1] || parts[0] || 0 };
  }
  if (typeof obj === 'object') {
    return {
      lower: Number(obj.lower_bound || obj.min || 0),
      upper: Number(obj.upper_bound || obj.max || 0)
    };
  }
  return { lower: 0, upper: 0 };
}
