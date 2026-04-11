// Meta Ad Library API — Real-time ad search for a specific domain/brand
// GET /api/meta-ads?domain=gymshark.com&limit=25
//
// Returns: { total, ads: [...], cached }
// Requires env vars: META_APP_ID, META_APP_SECRET

const GRAPH_API = 'https://graph.facebook.com/v21.0';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=1800'); // Cache 1h

  const domain = (req.query.domain || '').replace(/^www\./, '').trim().toLowerCase();
  const limit = Math.min(parseInt(req.query.limit) || 25, 100);
  const countOnly = req.query.count === 'true';

  if (!domain) {
    return res.status(400).json({ error: 'Missing domain parameter' });
  }

  const META_APP_ID = process.env.META_APP_ID || '';
  const META_APP_SECRET = process.env.META_APP_SECRET || '';

  if (!META_APP_ID || !META_APP_SECRET) {
    return res.status(500).json({
      error: 'Meta API not configured',
      message: 'META_APP_ID and META_APP_SECRET environment variables are required'
    });
  }

  const accessToken = `${META_APP_ID}|${META_APP_SECRET}`;

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

    // Get total count via pagination if we have results
    let total = result.data.length;
    if (result.paging && result.paging.next) {
      // There are more pages — count them
      total = await countAllAds(accessToken, domain, domain);
    }

    // Transform ads for the frontend
    const ads = result.data.slice(0, limit).map(transformAd);

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
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Meta API ${response.status}: ${errText.substring(0, 200)}`);
  }

  return await response.json();
}

async function countAllAds(accessToken, searchTerm, domain) {
  // Use minimal fields for fast counting
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
  const maxPages = 20; // Safety limit: max 10,000 ads counted
  let pages = 0;

  while (url && pages < maxPages) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) break;
      const data = await response.json();
      total += (data.data || []).length;
      url = data.paging && data.paging.next ? data.paging.next : null;
      pages++;
      // Small delay between pages to be nice to Meta's API
      if (url) await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      break;
    }
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
    snapshot_url: raw.ad_snapshot_url || null,
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
