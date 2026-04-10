// ============================================================
// PEEKR — Trending Ads Import Script
//
// HOW TO USE:
// Option A) Supabase Edge Function (recommended for automation)
// Option B) Run locally with Node.js: node import-trending-ads.js
//
// REQUIRED ENV VARS:
//   META_APP_ID
//   META_APP_SECRET
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY=<your service_role key from Supabase dashboard>
// ============================================================

const META_APP_ID = process.env.META_APP_ID || '';
const META_APP_SECRET = process.env.META_APP_SECRET || '';
const META_ACCESS_TOKEN = `${META_APP_ID}|${META_APP_SECRET}`;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://vsyceexjsitliwaasdhd.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

const GRAPH_API = 'https://graph.facebook.com/v21.0';

// E-commerce niches to search (FR + EN mix for EU coverage)
const SEARCH_TERMS = [
  'parfum', 'musc intime', 'skincare', 'beauté', 'maquillage',
  'soins visage', 'crème hydratante', 'sérum anti-âge', 'mode femme', 'robe',
  'bijoux', 'collier', 'bracelet', 'fitness', 'complément alimentaire',
  'protéine', 'yoga', 'cheveux', 'soin capillaire', 'décoration',
  'meuble', 'cuisine', 'gadget', 'coque téléphone', 'montre',
  'lunettes', 'sac à main', 'café', 'thé', 'bio',
  'vegan', 'gaming', 'LED', 'maison connectée', 'jardin',
  'bougie', 'chaussures', 'sneakers', 'perte de poids', 'sommeil',
  'massage', 'bébé', 'jouet enfant', 'voiture accessoire', 'running',
  'pilates', 'dental', 'weight loss', 'beauty', 'fashion'
];

const COUNTRIES = ['FR', 'DE', 'GB', 'ES', 'IT'];

const FIELDS = [
  'id', 'page_name', 'page_id',
  'ad_delivery_start_time',
  'ad_creative_bodies',
  'ad_snapshot_url',
  'eu_total_reach',
  'impressions',
  'spend',
  'publisher_platforms',
  'languages',
  'demographic_distribution',
  'delivery_by_region'
].join(',');

async function fetchAdsFromMeta(searchTerm, country, limit = 50) {
  const params = new URLSearchParams({
    access_token: META_ACCESS_TOKEN,
    search_terms: searchTerm,
    ad_reached_countries: `["${country}"]`,
    ad_type: 'ALL',
    fields: FIELDS,
    limit: String(limit),
    ad_active_status: 'ACTIVE'
  });
  const url = `${GRAPH_API}/ads_archive?${params}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.text();
      console.error(`Meta API error for "${searchTerm}" in ${country}: ${res.status}`);
      return [];
    }
    const json = await res.json();
    return json.data || [];
  } catch (e) {
    console.error(`Fetch error for "${searchTerm}": ${e.message}`);
    return [];
  }
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

function transformAd(raw, niche) {
  const impressions = parseRange(
    raw.impressions ? (Array.isArray(raw.impressions) ? raw.impressions[0] : raw.impressions) : null
  );
  const spend = parseRange(
    raw.spend ? (Array.isArray(raw.spend) ? raw.spend[0] : raw.spend) : null
  );
  return {
    meta_ad_id: raw.id,
    page_name: raw.page_name || null,
    page_id: raw.page_id || null,
    ad_creative_body: raw.ad_creative_bodies ? raw.ad_creative_bodies[0] : null,
    ad_snapshot_url: raw.ad_snapshot_url || null,
    ad_delivery_start_time: raw.ad_delivery_start_time || null,
    eu_total_reach: Number(raw.eu_total_reach) || 0,
    impressions_lower: impressions.lower,
    impressions_upper: impressions.upper,
    spend_lower: spend.lower,
    spend_upper: spend.upper,
    publisher_platforms: raw.publisher_platforms || [],
    languages: raw.languages || [],
    niche: niche,
    status: 'active'
  };
}

async function upsertToSupabase(ads) {
  if (ads.length === 0) return { inserted: 0, errors: 0 };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/ads`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(ads)
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`Supabase upsert error: ${res.status}`);
    return { inserted: 0, errors: ads.length };
  }
  return { inserted: ads.length, errors: 0 };
}

function isWorthTracking(ad) {
  if (!ad.ad_delivery_start_time) return false;
  const startDate = new Date(ad.ad_delivery_start_time);
  const daysSinceStart = Math.floor((Date.now() - startDate.getTime()) / (1000 * 60 * 60 * 24));
  if (daysSinceStart < 3) return false;
  if ((ad.eu_total_reach || 0) < 50 && (ad.impressions_upper || 0) < 100) return false;
  return true;
}

async function runImport() {
  if (!SUPABASE_SERVICE_KEY) {
    console.error('ERROR: SUPABASE_SERVICE_KEY is required.');
    process.exit(1);
  }
  console.log('=== PEEKR Trending Ads Import ===');
  let totalFetched = 0, totalInserted = 0, totalFiltered = 0;
  const seenIds = new Set();

  for (const term of SEARCH_TERMS) {
    for (const country of COUNTRIES) {
      await new Promise(r => setTimeout(r, 500));
      const raw = await fetchAdsFromMeta(term, country, 50);
      if (raw.length === 0) continue;
      totalFetched += raw.length;
      const transformed = raw
        .map(ad => transformAd(ad, term))
        .filter(ad => {
          if (seenIds.has(ad.meta_ad_id)) return false;
          seenIds.add(ad.meta_ad_id);
          return isWorthTracking(ad);
        });
      totalFiltered += (raw.length - transformed.length);
      if (transformed.length > 0) {
        for (let i = 0; i < transformed.length; i += 50) {
          const chunk = transformed.slice(i, i + 50);
          const result = await upsertToSupabase(chunk);
          totalInserted += result.inserted;
        }
      }
      process.stdout.write(`\r[${term}/${country}] Fetched: ${totalFetched} | Inserted: ${totalInserted}`);
    }
  }
  console.log('\n=== Import Complete ===');
  console.log(`Total fetched: ${totalFetched}, Inserted: ${totalInserted}, Filtered: ${totalFiltered}`);
}

runImport().catch(console.error);
