/**
 * Peekr SaaS Configuration & Auth Module
 *
 * IMPORTANT: Load the Supabase CDN BEFORE this script:
 * <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 * <script src="peekr-config.js"></script>
 *
 * Provides:
 * - Supabase client initialization
 * - Authentication management
 * - Database query utilities
 * - Feature gating & plan management
 * - UI helpers for upgrade banners
 *
 * Access via window.Peekr.*
 */

// Validate Supabase CDN is loaded
if (typeof supabase === 'undefined') {
  throw new Error('Supabase library not loaded. Ensure CDN is included before peekr-config.js');
}

// Plan limits configuration
const PLAN_LIMITS = {
  free: { shops: 5, ads: 0, savedShops: 2, savedAds: 0, brandTracker: 0, export: false, duel: false, blurSensitive: true },
  starter: { shops: 100, ads: 50, savedShops: 25, savedAds: 50, brandTracker: 3, export: false, duel: false, blurSensitive: false },
  pro: { shops: 1000, ads: 500, savedShops: -1, savedAds: -1, brandTracker: 10, export: true, duel: true, blurSensitive: false },
  agency: { shops: -1, ads: -1, savedShops: -1, savedAds: -1, brandTracker: -1, export: true, duel: true, blurSensitive: false }
};

// Initialize Supabase client
const supabaseClient = supabase.createClient(
  'https://vsyceexjsitliwaasdhd.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZzeWNlZXhqc2l0bGl3YWFzZGhkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0NDgzNzYsImV4cCI6MjA5MDAyNDM3Nn0.nng6CrCZIYiW3i-b3z5hm6AXhepA8t1CUhZ1Kt4aZwo'
);

/**
 * Core Auth Functions
 */

/**
 * Check if user has active session and redirect if not
 * @returns {Promise<Object>} Session object if authenticated
 */
async function requireAuth() {
  try {
    const { data: { session }, error } = await supabaseClient.auth.getSession();

    if (error) {
      console.error('Auth check error:', error);
      window.location.href = 'login.html';
      return null;
    }

    if (!session) {
      window.location.href = 'login.html';
      return null;
    }

    return session;
  } catch (err) {
    console.error('Session retrieval failed:', err);
    window.location.href = 'login.html';
    return null;
  }
}

/**
 * Get current authenticated user
 * @returns {Promise<Object|null>} User object or null if not authenticated
 */
async function getCurrentUser() {
  try {
    const { data: { user }, error } = await supabaseClient.auth.getUser();
    if (error) throw error;
    return user;
  } catch (err) {
    console.error('Failed to get current user:', err);
    return null;
  }
}

/**
 * Get user's current plan
 * @returns {Promise<string>} Plan name (free, starter, pro, agency)
 */
async function getUserPlan() {
  try {
    const user = await getCurrentUser();
    if (!user) return 'free';

    const { data, error } = await supabaseClient
      .from('subscriptions')
      .select('plan')
      .eq('user_id', user.id)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    return data?.plan || 'free';
  } catch (err) {
    console.error('Failed to get user plan:', err);
    return 'free';
  }
}

/**
 * Sign out user and redirect to login
 */
async function signOut() {
  try {
    await supabaseClient.auth.signOut();
    window.location.href = 'login.html';
  } catch (err) {
    console.error('Sign out error:', err);
    window.location.href = 'login.html';
  }
}

/**
 * Database Query Functions
 */

/**
 * Fetch shops with optional filters
 * @param {Object} filters - Optional filters {niche, country, minScore, maxScore, minVisits, maxVisits, trendTag, limit, offset, orderBy, orderDir}
 * @returns {Promise<Array>} Array of shop objects
 */
async function getShops(filters = {}) {
  try {
    const plan = await getUserPlan();
    const limit = filters.limit || PLAN_LIMITS[plan].shops;
    const offset = filters.offset || 0;
    const orderBy = filters.orderBy || 'score';
    const orderDir = filters.orderDir || 'desc';

    let query = supabaseClient.from('shops').select('*');

    // Apply filters
    if (filters.niche) query = query.eq('niche', filters.niche);
    if (filters.country) query = query.eq('country', filters.country);
    if (filters.minScore) query = query.gte('score', filters.minScore);
    if (filters.maxScore) query = query.lte('score', filters.maxScore);
    if (filters.minVisits) query = query.gte('visits', filters.minVisits);
    if (filters.maxVisits) query = query.lte('visits', filters.maxVisits);
    if (filters.trendTag) query = query.contains('trend_tags', [filters.trendTag]);

    // Add ordering and pagination
    query = query.order(orderBy, { ascending: orderDir === 'asc' });
    query = query.range(offset, offset + limit - 1);

    const { data, error } = await query;

    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('Failed to fetch shops:', err);
    return [];
  }
}

/**
 * Fetch ads with optional filters
 * @param {Object} filters - Optional filters {platform, format, status, shopId, limit, offset}
 * @returns {Promise<Array>} Array of ad objects
 */
async function getAds(filters = {}) {
  try {
    const plan = await getUserPlan();
    const limit = filters.limit || PLAN_LIMITS[plan].ads;
    const offset = filters.offset || 0;

    let query = supabaseClient.from('ads').select('*');

    // Apply filters
    if (filters.platform) query = query.eq('platform', filters.platform);
    if (filters.format) query = query.eq('format', filters.format);
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.shopId) query = query.eq('shop_id', filters.shopId);

    // Add ordering and pagination
    query = query.order('created_at', { ascending: false });
    query = query.range(offset, offset + limit - 1);

    const { data, error } = await query;

    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('Failed to fetch ads:', err);
    return [];
  }
}

/**
 * Save a shop to user's saved list
 * @param {string} shopId - Shop ID to save
 * @returns {Promise<boolean>} Success status
 */
async function saveShop(shopId) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new Error('Not authenticated');

    const { error } = await supabaseClient
      .from('saved_shops')
      .insert({ user_id: user.id, shop_id: shopId });

    if (error && error.code !== '23505') {
      throw error;
    }

    return true;
  } catch (err) {
    console.error('Failed to save shop:', err);
    return false;
  }
}

/**
 * Remove a shop from user's saved list
 * @param {string} shopId - Shop ID to unsave
 * @returns {Promise<boolean>} Success status
 */
async function unsaveShop(shopId) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new Error('Not authenticated');

    const { error } = await supabaseClient
      .from('saved_shops')
      .delete()
      .eq('user_id', user.id)
      .eq('shop_id', shopId);

    if (error) throw error;
    return true;
  } catch (err) {
    console.error('Failed to unsave shop:', err);
    return false;
  }
}

/**
 * Save an ad to user's saved list
 * @param {string} adId - Ad ID to save
 * @returns {Promise<boolean>} Success status
 */
async function saveAd(adId) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new Error('Not authenticated');

    const { error } = await supabaseClient
      .from('saved_ads')
      .insert({ user_id: user.id, ad_id: adId });

    if (error && error.code !== '23505') {
      throw error;
    }

    return true;
  } catch (err) {
    console.error('Failed to save ad:', err);
    return false;
  }
}

/**
 * Remove an ad from user's saved list
 * @param {string} adId - Ad ID to unsave
 * @returns {Promise<boolean>} Success status
 */
async function unsaveAd(adId) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new Error('Not authenticated');

    const { error } = await supabaseClient
      .from('saved_ads')
      .delete()
      .eq('user_id', user.id)
      .eq('ad_id', adId);

    if (error) throw error;
    return true;
  } catch (err) {
    console.error('Failed to unsave ad:', err);
    return false;
  }
}

/**
 * Get user's saved shops with full shop data
 * @returns {Promise<Array>} Array of saved shop objects
 */
async function getSavedShops() {
  try {
    const user = await getCurrentUser();
    if (!user) return [];

    const { data, error } = await supabaseClient
      .from('saved_shops')
      .select('shops(*)')
      .eq('user_id', user.id);

    if (error) throw error;

    return data?.map(item => item.shops).filter(Boolean) || [];
  } catch (err) {
    console.error('Failed to fetch saved shops:', err);
    return [];
  }
}

/**
 * Get user's saved ads with full ad data
 * @returns {Promise<Array>} Array of saved ad objects
 */
async function getSavedAds() {
  try {
    const user = await getCurrentUser();
    if (!user) return [];

    const { data, error } = await supabaseClient
      .from('saved_ads')
      .select('ads(*)')
      .eq('user_id', user.id);

    if (error) throw error;

    return data?.map(item => item.ads).filter(Boolean) || [];
  } catch (err) {
    console.error('Failed to fetch saved ads:', err);
    return [];
  }
}

/**
 * Brand Tracker Functions
 */

/**
 * Add a brand to user's tracked brands
 * @param {string} shopId - Shop ID to track
 * @returns {Promise<boolean>} Success status
 */
async function trackBrand(shopId) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new Error('Not authenticated');

    const { error } = await supabaseClient
      .from('brand_trackers')
      .insert({ user_id: user.id, shop_id: shopId });

    if (error && error.code !== '23505') {
      throw error;
    }

    return true;
  } catch (err) {
    console.error('Failed to track brand:', err);
    return false;
  }
}

/**
 * Remove a brand from user's tracked brands
 * @param {string} shopId - Shop ID to untrack
 * @returns {Promise<boolean>} Success status
 */
async function untrackBrand(shopId) {
  try {
    const user = await getCurrentUser();
    if (!user) throw new Error('Not authenticated');

    const { error } = await supabaseClient
      .from('brand_trackers')
      .delete()
      .eq('user_id', user.id)
      .eq('shop_id', shopId);

    if (error) throw error;
    return true;
  } catch (err) {
    console.error('Failed to untrack brand:', err);
    return false;
  }
}

/**
 * Get user's tracked brands with full shop data
 * @returns {Promise<Array>} Array of tracked brand objects
 */
async function getTrackedBrands() {
  try {
    const user = await getCurrentUser();
    if (!user) return [];

    const { data, error } = await supabaseClient
      .from('brand_trackers')
      .select('shops(*)')
      .eq('user_id', user.id);

    if (error) throw error;

    return data?.map(item => item.shops).filter(Boolean) || [];
  } catch (err) {
    console.error('Failed to fetch tracked brands:', err);
    return [];
  }
}

/**
 * Get unread brand alerts
 * @returns {Promise<Array>} Array of alert objects
 */
async function getBrandAlerts() {
  try {
    const user = await getCurrentUser();
    if (!user) return [];

    const { data, error } = await supabaseClient
      .from('brand_alerts')
      .select('*')
      .eq('user_id', user.id)
      .eq('read', false)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('Failed to fetch brand alerts:', err);
    return [];
  }
}

/**
 * Get niche trends data
 * @returns {Promise<Array>} Array of trend objects
 */
async function getNicheTrends() {
  try {
    const { data, error } = await supabaseClient
      .from('niche_trends')
      .select('*')
      .order('trend_score', { ascending: false });

    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('Failed to fetch niche trends:', err);
    return [];
  }
}

/**
 * Export data in specified format
 * @param {string} format - Export format (csv, json)
 * @param {string} dataSource - Data source (shops, ads, savedShops, savedAds, trackedBrands)
 * @param {Array} columns - Columns to include in export
 * @returns {Promise<Blob|null>} Exported data blob
 */
async function exportData(format, dataSource, columns = []) {
  try {
    const plan = await getUserPlan();
    if (!PLAN_LIMITS[plan].export) {
      throw new Error('Export not available on current plan');
    }

    let data = [];

    // Fetch data based on source
    switch (dataSource) {
      case 'shops':
        data = await getShops({ limit: -1 });
        break;
      case 'ads':
        data = await getAds({ limit: -1 });
        break;
      case 'savedShops':
        data = await getSavedShops();
        break;
      case 'savedAds':
        data = await getSavedAds();
        break;
      case 'trackedBrands':
        data = await getTrackedBrands();
        break;
      default:
        throw new Error('Invalid data source');
    }

    // Filter columns if specified
    if (columns.length > 0) {
      data = data.map(item => {
        const filtered = {};
        columns.forEach(col => {
          if (col in item) filtered[col] = item[col];
        });
        return filtered;
      });
    }

    // Convert to desired format
    let content;
    let mimeType;
    let filename;

    if (format === 'csv') {
      content = convertToCSV(data);
      mimeType = 'text/csv;charset=utf-8;';
      filename = `${dataSource}-export-${Date.now()}.csv`;
    } else if (format === 'json') {
      content = JSON.stringify(data, null, 2);
      mimeType = 'application/json;charset=utf-8;';
      filename = `${dataSource}-export-${Date.now()}.json`;
    } else {
      throw new Error('Unsupported export format');
    }

    const blob = new Blob([content], { type: mimeType });
    return blob;
  } catch (err) {
    console.error('Export failed:', err);
    return null;
  }
}

/**
 * Helper function to convert data to CSV
 * @param {Array} data - Data to convert
 * @returns {string} CSV formatted string
 */
function convertToCSV(data) {
  if (!data || data.length === 0) return '';

  const headers = Object.keys(data[0]);
  const headerRow = headers.map(h => `"${h}"`).join(',');

  const rows = data.map(item => {
    return headers.map(header => {
      const value = item[header];
      if (value === null || value === undefined) return '';
      if (typeof value === 'object') return `"${JSON.stringify(value)}"`;
      return `"${String(value).replace(/"/g, '""')}"`;
    }).join(',');
  });

  return [headerRow, ...rows].join('\n');
}

/**
 * Feature Gating & Plan Management
 */

/**
 * Check if user can access a feature
 * @param {string} feature - Feature name (dashboard, trending-ads, best-trends, saved, brand-tracker, export, duel, api)
 * @returns {Promise<boolean>} Whether feature is accessible
 */
async function canAccess(feature) {
  try {
    const plan = await getUserPlan();

    const featureMap = {
      'dashboard': ['free', 'starter', 'pro', 'agency'],
      'overview': ['free', 'starter', 'pro', 'agency'],
      'trending-ads': ['starter', 'pro', 'agency'],
      'best-trends': ['free', 'starter', 'pro', 'agency'],
      'saved': ['free', 'starter', 'pro', 'agency'],
      'brand-tracker': ['starter', 'pro', 'agency'],
      'export': ['pro', 'agency'],
      'duel': ['pro', 'agency'],
      'api': ['agency']
    };

    return featureMap[feature]?.includes(plan) || false;
  } catch (err) {
    console.error('Feature access check error:', err);
    return false;
  }
}

/**
 * Get result limit for current user's plan
 * @param {string} dataType - Data type (shops, ads, savedShops, savedAds, brandTracker)
 * @returns {Promise<number>} Max results allowed (-1 for unlimited)
 */
async function getResultLimit(dataType) {
  try {
    const plan = await getUserPlan();
    const limit = PLAN_LIMITS[plan][dataType];
    return limit !== undefined ? limit : 0;
  } catch (err) {
    console.error('Failed to get result limit:', err);
    return 0;
  }
}

/**
 * UI Helper Functions
 */

/**
 * Show upgrade banner when feature is locked
 * @param {string} feature - Feature name
 * @param {string} requiredPlan - Required plan for feature
 */
function showUpgradeBanner(feature, requiredPlan) {
  const bannerId = `upgrade-banner-${feature}`;

  // Avoid duplicate banners
  if (document.getElementById(bannerId)) return;

  const banner = document.createElement('div');
  banner.id = bannerId;
  banner.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    padding: 16px 20px;
    text-align: center;
    font-size: 14px;
    font-weight: 500;
    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    z-index: 1000;
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 16px;
  `;

  const textSpan = document.createElement('span');
  textSpan.textContent = `Upgrade to ${requiredPlan} plan to access ${feature}`;

  const upgradeBtn = document.createElement('button');
  upgradeBtn.textContent = 'Upgrade Now';
  upgradeBtn.style.cssText = `
    background: white;
    color: #667eea;
    border: none;
    padding: 8px 16px;
    border-radius: 4px;
    font-weight: 600;
    cursor: pointer;
    font-size: 13px;
    transition: all 0.2s;
  `;
  upgradeBtn.onmouseover = () => {
    upgradeBtn.style.transform = 'translateY(-2px)';
    upgradeBtn.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
  };
  upgradeBtn.onmouseout = () => {
    upgradeBtn.style.transform = 'translateY(0)';
    upgradeBtn.style.boxShadow = 'none';
  };
  upgradeBtn.onclick = () => {
    window.location.href = 'pricing.html';
  };

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.style.cssText = `
    background: rgba(255,255,255,0.2);
    border: none;
    color: white;
    font-size: 24px;
    cursor: pointer;
    padding: 0;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.2s;
  `;
  closeBtn.onmouseover = () => {
    closeBtn.style.background = 'rgba(255,255,255,0.3)';
  };
  closeBtn.onmouseout = () => {
    closeBtn.style.background = 'rgba(255,255,255,0.2)';
  };
  closeBtn.onclick = () => {
    banner.remove();
  };

  banner.appendChild(textSpan);
  banner.appendChild(upgradeBtn);
  banner.appendChild(closeBtn);
  document.body.insertBefore(banner, document.body.firstChild);
}

/**
 * Auth State Listener
 * Automatically manages auth state changes
 */
supabaseClient.auth.onAuthStateChange(async (event, session) => {
  try {
    if (event === 'SIGNED_OUT') {
      // Redirect to login on sign out
      window.location.href = 'login.html';
    } else if (event === 'SIGNED_IN' && session) {
      // Ensure subscription row exists for new users
      const { error } = await supabaseClient
        .from('subscriptions')
        .upsert(
          { user_id: session.user.id, plan: 'free' },
          { onConflict: 'user_id' }
        );

      if (error) {
        console.error('Failed to create subscription record:', error);
      }
    }
  } catch (err) {
    console.error('Auth state change error:', err);
  }
});

/**
 * Freemium UI Helpers
 */

/**
 * Inject freemium CSS styles into the page
 */
function injectFreemiumStyles() {
  if (document.getElementById('peekr-freemium-css')) return;
  const style = document.createElement('style');
  style.id = 'peekr-freemium-css';
  style.textContent = `
    .pkr-blurred { filter: blur(8px); user-select: none; pointer-events: none; transition: filter .3s; }
    .pkr-blurred-row { position: relative; }
    .pkr-blurred-row > td, .pkr-blurred-row > div { filter: blur(7px); user-select: none; }
    .pkr-blurred-row > td:first-child, .pkr-blurred-row > td:nth-child(2) { filter: none; }
    .pkr-sensitive { filter: blur(7px); user-select: none; pointer-events: none; }
    .pkr-lock-overlay {
      position: fixed; inset: 0; z-index: 9999;
      background: rgba(255,240,244,0.92); backdrop-filter: blur(6px);
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      text-align: center; padding: 40px;
    }
    .pkr-lock-overlay .pkr-lock-icon { font-size: 64px; margin-bottom: 20px; }
    .pkr-lock-overlay h2 { font-size: 28px; font-weight: 800; color: #1A0A0F; margin-bottom: 12px; letter-spacing: -0.03em; }
    .pkr-lock-overlay p { font-size: 15px; color: #7A6068; max-width: 420px; line-height: 1.6; margin-bottom: 28px; }
    .pkr-lock-overlay .pkr-upgrade-btn {
      background: #1A0A0F; color: #fff; border: none; padding: 14px 36px;
      border-radius: 100px; font-size: 15px; font-weight: 700; cursor: pointer;
      font-family: 'Figtree', sans-serif; transition: all .25s; text-decoration: none; display: inline-block;
    }
    .pkr-lock-overlay .pkr-upgrade-btn:hover { background: #E8799A; transform: translateY(-2px); }
    .pkr-lock-overlay .pkr-plans-hint { font-size: 12px; color: #7A6068; margin-top: 12px; }
    .pkr-upgrade-badge {
      position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
      background: linear-gradient(135deg, #1A0A0F, #E8799A); color: #fff;
      padding: 8px 18px; border-radius: 100px; font-size: 12px; font-weight: 700;
      white-space: nowrap; z-index: 10; pointer-events: auto; cursor: pointer;
      box-shadow: 0 4px 16px rgba(232,121,154,0.3); transition: all .25s;
    }
    .pkr-upgrade-badge:hover { transform: translate(-50%, -50%) scale(1.05); box-shadow: 0 6px 24px rgba(232,121,154,0.4); }
    .pkr-row-locked { position: relative; overflow: visible; }
  `;
  document.head.appendChild(style);
}

/**
 * Show a full-page lock overlay for pages blocked on free plan
 * @param {string} feature - Feature name to display
 * @param {string} minPlan - Minimum plan required
 */
function showPageLock(feature, minPlan) {
  injectFreemiumStyles();
  const overlay = document.createElement('div');
  overlay.className = 'pkr-lock-overlay';
  overlay.innerHTML = `
    <div class="pkr-lock-icon">🔒</div>
    <h2>${feature} is a ${minPlan}+ feature</h2>
    <p>Upgrade your plan to unlock ${feature} and get full access to Peekr's ecom intelligence tools.</p>
    <a href="peekr-pricing.html" class="pkr-upgrade-btn">See plans & upgrade →</a>
    <div class="pkr-plans-hint">Starting at $29/mo — cancel anytime</div>
  `;
  document.body.appendChild(overlay);
}

/**
 * Apply blur to sensitive data cells in a table row or card
 * Call this on elements containing revenue, traffic, apps, strategies data
 * @param {HTMLElement} el - Element to blur
 */
function blurElement(el) {
  injectFreemiumStyles();
  el.classList.add('pkr-sensitive');
}

/**
 * Make a table row appear locked (blurred with upgrade badge)
 * @param {HTMLElement} row - TR element
 * @param {number} index - Row index (for positioning)
 */
function lockTableRow(row, index) {
  injectFreemiumStyles();
  row.classList.add('pkr-blurred-row', 'pkr-row-locked');
  const badge = document.createElement('a');
  badge.href = 'peekr-pricing.html';
  badge.className = 'pkr-upgrade-badge';
  badge.textContent = '🔒 Upgrade to unlock';
  badge.style.position = 'absolute';
  badge.style.right = '20px';
  badge.style.top = '50%';
  badge.style.transform = 'translateY(-50%)';
  badge.style.left = 'auto';
  row.style.position = 'relative';
  row.appendChild(badge);
}

/**
 * Apply freemium restrictions to the current page
 * Call after DOM is ready and data is rendered
 * @param {string} page - Page identifier (dashboard, trending-ads, overview, best-trends, saved, brand-tracker, duel, export)
 * @param {Object} options - { tableSelector, rowSelector, sensitiveSelectors, visibleCount }
 */
async function applyFreemiumRestrictions(page, options = {}) {
  const plan = await getUserPlan();
  const limits = PLAN_LIMITS[plan];

  // If not free plan, no restrictions to apply (starter+ see everything on accessible pages)
  if (plan !== 'free') return { plan, restricted: false };

  injectFreemiumStyles();

  // Check if page is fully locked
  const hasAccess = await canAccess(page);
  if (!hasAccess) {
    const planNames = { 'trending-ads': 'Starter', 'brand-tracker': 'Starter', 'export': 'Pro', 'duel': 'Pro' };
    showPageLock(page.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()), planNames[page] || 'Starter');
    return { plan, restricted: true, locked: true };
  }

  // Apply row-level restrictions (blur rows beyond visible count)
  const visibleCount = options.visibleCount || limits.shops;
  if (options.rowSelector) {
    const rows = document.querySelectorAll(options.rowSelector);
    rows.forEach((row, i) => {
      if (i >= visibleCount) {
        lockTableRow(row, i);
      }
    });
  }

  // Apply sensitive data blur
  if (limits.blurSensitive && options.sensitiveSelectors) {
    options.sensitiveSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => blurElement(el));
    });
  }

  return { plan, restricted: true, locked: false };
}

/**
 * Export all functions to global Peekr namespace
 */
window.Peekr = {
  // Auth
  requireAuth,
  getCurrentUser,
  getUserPlan,
  signOut,

  // Shops
  getShops,
  saveShop,
  unsaveShop,
  getSavedShops,

  // Ads
  getAds,
  saveAd,
  unsaveAd,
  getSavedAds,

  // Brand Tracker
  trackBrand,
  untrackBrand,
  getTrackedBrands,
  getBrandAlerts,

  // Trends
  getNicheTrends,

  // Export
  exportData,

  // Feature Gating
  canAccess,
  getResultLimit,

  // UI
  showUpgradeBanner,
  showPageLock,
  blurElement,
  lockTableRow,
  applyFreemiumRestrictions,
  injectFreemiumStyles,

  // Constants
  PLAN_LIMITS
};

// Make Supabase client accessible if needed
window.Peekr.supabase = supabaseClient;

console.log('Peekr config loaded successfully');
