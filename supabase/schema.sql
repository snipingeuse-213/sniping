-- Peekr Supabase Schema
-- Complete PostgreSQL schema for ecom intelligence SaaS

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- SHOPS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS shops (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  domain TEXT UNIQUE NOT NULL,
  niche TEXT,
  score INTEGER DEFAULT 0 CHECK (score >= 0 AND score <= 100),
  trend_tag TEXT CHECK (trend_tag IN ('hot', 'rising', 'watch', 'cold')),
  country TEXT, -- 2-letter code
  country2 TEXT, -- secondary market
  created_date DATE,
  monthly_visits BIGINT,
  revenue_min INTEGER,
  revenue_max INTEGER,
  live_ads INTEGER DEFAULT 0,
  theme TEXT,
  currency TEXT, -- 3-letter code
  products_count INTEGER,
  language TEXT,
  shopify_plan TEXT,
  apps TEXT[] DEFAULT '{}', -- array of app names
  ad_platforms TEXT[] DEFAULT '{}',
  strategies TEXT[] DEFAULT '{}',
  visitor_countries TEXT[] DEFAULT '{}',
  traffic_trend INTEGER[] DEFAULT '{}', -- 12 weeks of traffic data
  last_scraped TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for shops
CREATE INDEX idx_shops_domain ON shops(domain);
CREATE INDEX idx_shops_niche ON shops(niche);
CREATE INDEX idx_shops_score ON shops(score DESC);
CREATE INDEX idx_shops_country ON shops(country);
CREATE INDEX idx_shops_monthly_visits ON shops(monthly_visits DESC);
CREATE INDEX idx_shops_trend_tag ON shops(trend_tag);
CREATE INDEX idx_shops_created_at ON shops(created_at DESC);

-- ============================================================================
-- ADS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS ads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('meta', 'tiktok', 'google', 'pinterest', 'snapchat')),
  format TEXT CHECK (format IN ('image', 'video', 'carousel', 'collection')),
  headline TEXT,
  copy TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'new', 'archived')),
  days_active INTEGER,
  likes INTEGER DEFAULT 0,
  shares INTEGER DEFAULT 0,
  creative_url TEXT,
  ad_library_url TEXT,
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for ads
CREATE INDEX idx_ads_shop_id ON ads(shop_id);
CREATE INDEX idx_ads_platform ON ads(platform);
CREATE INDEX idx_ads_status ON ads(status);
CREATE INDEX idx_ads_detected_at ON ads(detected_at DESC);
CREATE INDEX idx_ads_shop_platform ON ads(shop_id, platform);

-- ============================================================================
-- USER SAVED SHOPS (Favorites)
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_saved_shops (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  saved_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, shop_id)
);

-- Index for user_saved_shops
CREATE INDEX idx_user_saved_shops_user_id ON user_saved_shops(user_id);
CREATE INDEX idx_user_saved_shops_saved_at ON user_saved_shops(saved_at DESC);

-- ============================================================================
-- USER SAVED ADS (Favorites)
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_saved_ads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ad_id UUID NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
  saved_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, ad_id)
);

-- Index for user_saved_ads
CREATE INDEX idx_user_saved_ads_user_id ON user_saved_ads(user_id);
CREATE INDEX idx_user_saved_ads_saved_at ON user_saved_ads(saved_at DESC);

-- ============================================================================
-- TRACKED BRANDS (per user)
-- ============================================================================
CREATE TABLE IF NOT EXISTS tracked_brands (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  alerts_enabled BOOLEAN DEFAULT true,
  tracked_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, shop_id)
);

-- Index for tracked_brands
CREATE INDEX idx_tracked_brands_user_id ON tracked_brands(user_id);
CREATE INDEX idx_tracked_brands_shop_id ON tracked_brands(shop_id);

-- ============================================================================
-- BRAND ALERTS (Alert History)
-- ============================================================================
CREATE TABLE IF NOT EXISTS brand_alerts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL CHECK (alert_type IN ('score_change', 'ads_spike', 'traffic_change', 'new_app', 'products_change')),
  message TEXT,
  old_value TEXT,
  new_value TEXT,
  read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for brand_alerts
CREATE INDEX idx_brand_alerts_user_id ON brand_alerts(user_id);
CREATE INDEX idx_brand_alerts_created_at ON brand_alerts(created_at DESC);
CREATE INDEX idx_brand_alerts_shop_id ON brand_alerts(shop_id);
CREATE INDEX idx_brand_alerts_read ON brand_alerts(read) WHERE read = false;

-- ============================================================================
-- SUBSCRIPTIONS
-- ============================================================================
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  plan TEXT DEFAULT 'free' CHECK (plan IN ('free', 'starter', 'pro', 'agency')),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'canceled', 'past_due', 'trialing', 'paused')),
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for subscriptions
CREATE INDEX idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_stripe_customer_id ON subscriptions(stripe_customer_id);

-- ============================================================================
-- NICHE TRENDS
-- ============================================================================
CREATE TABLE IF NOT EXISTS niche_trends (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  niche TEXT NOT NULL,
  growth_pct NUMERIC,
  shop_count INTEGER,
  avg_score NUMERIC,
  period TEXT CHECK (period IN ('7d', '30d', '90d')),
  computed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for niche_trends
CREATE INDEX idx_niche_trends_period ON niche_trends(period);
CREATE INDEX idx_niche_trends_niche ON niche_trends(niche);
CREATE INDEX idx_niche_trends_computed_at ON niche_trends(computed_at DESC);

-- ============================================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_saved_shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_saved_ads ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracked_brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE brand_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE niche_trends ENABLE ROW LEVEL SECURITY;

-- Shops: readable by all authenticated users
CREATE POLICY "Enable read access for authenticated users" ON shops
  FOR SELECT USING (auth.role() = 'authenticated_user');

-- Ads: readable by all authenticated users
CREATE POLICY "Enable read access for authenticated users" ON ads
  FOR SELECT USING (auth.role() = 'authenticated_user');

-- User saved shops: users can only read/write their own
CREATE POLICY "Enable read for own saved shops" ON user_saved_shops
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Enable insert for own saved shops" ON user_saved_shops
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Enable delete for own saved shops" ON user_saved_shops
  FOR DELETE USING (auth.uid() = user_id);

-- User saved ads: users can only read/write their own
CREATE POLICY "Enable read for own saved ads" ON user_saved_ads
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Enable insert for own saved ads" ON user_saved_ads
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Enable delete for own saved ads" ON user_saved_ads
  FOR DELETE USING (auth.uid() = user_id);

-- Tracked brands: users can only read/write their own
CREATE POLICY "Enable read for own tracked brands" ON tracked_brands
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Enable insert for own tracked brands" ON tracked_brands
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Enable update for own tracked brands" ON tracked_brands
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Enable delete for own tracked brands" ON tracked_brands
  FOR DELETE USING (auth.uid() = user_id);

-- Brand alerts: users can only read their own
CREATE POLICY "Enable read for own alerts" ON brand_alerts
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Enable update for own alerts" ON brand_alerts
  FOR UPDATE USING (auth.uid() = user_id);

-- Subscriptions: users can only read their own
CREATE POLICY "Enable read for own subscription" ON subscriptions
  FOR SELECT USING (auth.uid() = user_id);

-- Niche trends: readable by all authenticated users
CREATE POLICY "Enable read access for authenticated users" ON niche_trends
  FOR SELECT USING (auth.role() = 'authenticated_user');

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for shops.updated_at
CREATE TRIGGER update_shops_updated_at
  BEFORE UPDATE ON shops
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Trigger for ads.updated_at
CREATE TRIGGER update_ads_updated_at
  BEFORE UPDATE ON ads
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Trigger for subscriptions.updated_at
CREATE TRIGGER update_subscriptions_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- MATERIALIZED VIEWS FOR PERFORMANCE
-- ============================================================================

-- Top shops by score
CREATE MATERIALIZED VIEW IF NOT EXISTS top_shops_by_score AS
SELECT
  id,
  name,
  domain,
  niche,
  score,
  trend_tag,
  country,
  monthly_visits,
  revenue_min,
  revenue_max,
  live_ads,
  products_count
FROM shops
WHERE score > 0
ORDER BY score DESC, monthly_visits DESC
LIMIT 1000;

CREATE INDEX idx_top_shops_view_score ON top_shops_by_score(score DESC);

-- Trending niches summary
CREATE MATERIALIZED VIEW IF NOT EXISTS trending_niches_summary AS
SELECT
  niche,
  COUNT(*) as shop_count,
  ROUND(AVG(score)) as avg_score,
  COUNT(CASE WHEN trend_tag = 'hot' THEN 1 END) as hot_count,
  COUNT(CASE WHEN trend_tag = 'rising' THEN 1 END) as rising_count
FROM shops
WHERE niche IS NOT NULL
GROUP BY niche
ORDER BY shop_count DESC;

-- ============================================================================
-- COMMENTS FOR DOCUMENTATION
-- ============================================================================
COMMENT ON TABLE shops IS 'Main stores/brands being tracked. Central table for Peekr intelligence.';
COMMENT ON TABLE ads IS 'Ad creatives detected across platforms. Links to shops via shop_id.';
COMMENT ON TABLE user_saved_shops IS 'User favorites/bookmarks for shops. Tracks which shops users are interested in.';
COMMENT ON TABLE user_saved_ads IS 'User favorites/bookmarks for ads. Tracks which ad creatives users saved.';
COMMENT ON TABLE tracked_brands IS 'Brands actively tracked by users for alerts. Enables brand monitoring.';
COMMENT ON TABLE brand_alerts IS 'Alert history for tracked brands. Records all changes and events.';
COMMENT ON TABLE subscriptions IS 'User subscription/plan information. Integrates with Stripe.';
COMMENT ON TABLE niche_trends IS 'Trending niches computed periodically. Used for trend discovery.';

COMMENT ON COLUMN shops.score IS 'Composite score 0-100 based on traffic growth, ads, revenue, product diversity, and app ecosystem.';
COMMENT ON COLUMN shops.trend_tag IS 'Tag indicating shop trend status: hot, rising, watch, or cold.';
COMMENT ON COLUMN shops.traffic_trend IS 'Array of 12 weekly traffic data points for trend visualization.';
COMMENT ON COLUMN ads.platform IS 'Ad platform where ad was detected: meta, tiktok, google, pinterest, or snapchat.';
COMMENT ON COLUMN ads.format IS 'Ad format: image, video, carousel, or collection.';
