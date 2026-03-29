// Peekr Shopify Store Scraper
// Runs as Vercel Serverless Function - discovers & scrapes Shopify stores
// Called by Vercel Cron every minute

const SUPABASE_URL = 'https://vsyceexjsitliwaasdhd.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZzeWNlZXhqc2l0bGl3YWFzZGhkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0NDgzNzYsImV4cCI6MjA5MDAyNDM3Nn0.nng6CrCZIYiW3i-b3z5hm6AXhepA8t1CUhZ1Kt4aZwo';
const STORELEADS_KEY = '0828c887-79f6-45b0-5ea9-e3427cb4';

// Score calculation (same as dashboard)
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

// Upsert shops to Supabase
async function upsertShops(shops) {
  if (!shops.length) return 0;

  // Batch upsert via POST
  const res = await fetch(`${SUPABASE_URL}/rest/v1/shops`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify(shops)
  });

  if (!res.ok) {
    console.error('Upsert error:', res.status, await res.text());
    return 0;
  }
  return shops.length;
}

// METHOD 1: Store Leads API - fetch by country + category + sort
async function fetchStoreLeads(country, sort, offset, category) {
  let url = `https://storeleads.app/json/api/v1/all/domain?p=shopify&ds=active&sort=${sort}&limit=50&offset=${offset}&c=${country}`;
  if (category) url += `&cat=${category}`;

  try {
    const res = await fetch(url, {
      headers: { 'Authorization': `Token ${STORELEADS_KEY}` }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.domains || []).map(d => {
      const visits = d.estimated_visits || 0;
      const sales = d.estimated_sales || 0;
      const rank = d.platform_rank || 999999;
      const prods = d.product_count || 0;
      const appCount = Array.isArray(d.apps) ? d.apps.length : 0;
      const score = calculateScore(visits, sales, rank, prods, appCount);
      const catStr = Array.isArray(d.categories) ? d.categories.join(',') : '';

      return {
        domain: d.name,
        name: d.merchant_name || d.title || d.name,
        title: d.title,
        merchant_name: d.merchant_name,
        niche: detectNiche(catStr),
        score,
        trend_tag: getTrendTag(score),
        country,
        monthly_visits: visits,
        estimated_sales: sales,
        products_count: prods,
        platform_rank: rank,
        categories: Array.isArray(d.categories) ? d.categories : [],
        apps: Array.isArray(d.apps) ? d.apps : [],
        technologies: Array.isArray(d.technologies) ? d.technologies : [],
        description: d.description,
        city: d.city,
        region: d.region,
        icon: d.icon,
        last_scraped: new Date().toISOString()
      };
    });
  } catch (e) {
    console.error('StoreLeads error:', e.message);
    return [];
  }
}

// METHOD 2: Direct Shopify /products.json scraper
async function scrapeShopifyStore(domain) {
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5000); // 5s timeout per store

    const res = await fetch(`https://${domain}/products.json?limit=250`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PeekrBot/1.0)' }
    });

    if (!res.ok) return null;
    const data = await res.json();
    const products = data.products || [];

    if (!products.length) return null;

    // Extract useful data
    const categories = [...new Set(products.map(p => p.product_type).filter(Boolean))];
    const vendors = [...new Set(products.map(p => p.vendor).filter(Boolean))];
    const totalProducts = products.length;

    // Detect niche from product types
    const niche = detectNiche(categories.join(','));

    return {
      domain,
      products_count: totalProducts,
      categories,
      niche,
      vendors,
      last_scraped: new Date().toISOString()
    };
  } catch (e) {
    return null;
  }
}

// METHOD 3: Discover new Shopify stores via known patterns
async function discoverStores(seed) {
  const discovered = [];

  // Try common Shopify store name patterns
  const prefixes = [
    'the', 'my', 'get', 'shop', 'buy', 'best', 'top', 'pro', 'super', 'ultra',
    'pure', 'fresh', 'luxe', 'glow', 'zen', 'vibe', 'nova', 'bloom', 'wild', 'bold'
  ];
  const suffixes = [
    'store', 'shop', 'co', 'hub', 'lab', 'box', 'club', 'world', 'zone', 'gear',
    'beauty', 'style', 'fit', 'life', 'home', 'wear', 'tech', 'pets', 'food', 'skin'
  ];

  // Generate candidates based on seed number (different each run)
  const startIdx = (seed % prefixes.length);
  const candidates = [];
  for (let i = 0; i < 5; i++) {
    const p = prefixes[(startIdx + i) % prefixes.length];
    for (let j = 0; j < 4; j++) {
      const s = suffixes[(startIdx + j) % suffixes.length];
      candidates.push(`${p}${s}.myshopify.com`);
      candidates.push(`${p}-${s}.myshopify.com`);
    }
  }

  // Test each candidate (quick HEAD request)
  const checks = candidates.map(async (domain) => {
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`https://${domain}`, {
        method: 'HEAD',
        signal: controller.signal,
        redirect: 'follow'
      });
      if (res.ok) {
        // Get the final URL (might redirect to custom domain)
        const finalDomain = new URL(res.url).hostname.replace('www.', '');
        return finalDomain;
      }
    } catch (e) {}
    return null;
  });

  const results = await Promise.allSettled(checks);
  return results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);
}

// Get import state from Supabase
async function getImportState() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/import_progress?completed=eq.false&order=id&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    if (res.ok) {
      const data = await res.json();
      return data[0] || null;
    }
  } catch (e) {}
  return null;
}

async function updateImportState(id, offset, inserted) {
  await fetch(`${SUPABASE_URL}/rest/v1/import_progress?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      last_offset: offset,
      shops_imported: inserted,
      last_run_at: new Date().toISOString(),
      completed: offset >= 1000
    })
  });
}

// Main handler
export default async function handler(req, res) {
  const startTime = Date.now();
  let totalImported = 0;
  const results = { storeleads: 0, scraped: 0, discovered: 0 };

  try {
    // PHASE 1: Store Leads API import (5 pages = 250 shops)
    const task = await getImportState();
    if (task) {
      const pages = 5;
      for (let p = 0; p < pages; p++) {
        const offset = task.last_offset + p * 50;
        if (offset >= 1000) break;

        const shops = await fetchStoreLeads(
          task.country,
          task.sort_type,
          offset,
          task.category || ''
        );

        if (shops.length > 0) {
          const count = await upsertShops(shops);
          results.storeleads += count;
        } else {
          break; // No more data for this task
        }
      }

      const newOffset = Math.min(task.last_offset + pages * 50, 1000);
      await updateImportState(task.id, newOffset, (task.shops_imported || 0) + results.storeleads);
    }

    // PHASE 2: Enrich existing shops by scraping /products.json
    // Get 10 shops that haven't been scraped recently
    const enrichRes = await fetch(
      `${SUPABASE_URL}/rest/v1/shops?products_count=eq.0&limit=10&order=score.desc`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );

    if (enrichRes.ok) {
      const shopsToEnrich = await enrichRes.json();
      const enrichPromises = shopsToEnrich.map(s => scrapeShopifyStore(s.domain));
      const enrichResults = await Promise.allSettled(enrichPromises);

      for (const r of enrichResults) {
        if (r.status === 'fulfilled' && r.value) {
          const data = r.value;
          await fetch(`${SUPABASE_URL}/rest/v1/shops?domain=eq.${encodeURIComponent(data.domain)}`, {
            method: 'PATCH',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              products_count: data.products_count,
              niche: data.niche,
              categories: data.categories,
              last_scraped: data.last_scraped
            })
          });
          results.scraped++;
        }
      }
    }

    // PHASE 3: Discover new stores
    const seed = Math.floor(Date.now() / 60000); // Changes every minute
    const newDomains = await discoverStores(seed);

    if (newDomains.length > 0) {
      const newShops = [];
      for (const domain of newDomains) {
        const scraped = await scrapeShopifyStore(domain);
        if (scraped) {
          newShops.push({
            domain,
            name: domain.replace('.myshopify.com', '').replace(/[-.]/g, ' '),
            niche: scraped.niche,
            score: 10,
            trend_tag: 'cold',
            country: 'US',
            products_count: scraped.products_count,
            categories: scraped.categories,
            last_scraped: new Date().toISOString()
          });
        }
      }

      if (newShops.length > 0) {
        results.discovered = await upsertShops(newShops);
      }
    }

    totalImported = results.storeleads + results.scraped + results.discovered;
    const elapsed = Date.now() - startTime;

    res.status(200).json({
      success: true,
      imported: totalImported,
      details: results,
      elapsed_ms: elapsed,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      imported: totalImported,
      details: results
    });
  }
}
