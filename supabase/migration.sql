-- ============================================================================
-- PEEKR COMPLETE MIGRATION
-- Drop old tables, create new schema, functions, and seed data
-- ============================================================================

-- Drop existing objects (safe cleanup)
DROP MATERIALIZED VIEW IF EXISTS trending_niches_summary CASCADE;
DROP MATERIALIZED VIEW IF EXISTS top_shops_by_score CASCADE;
DROP TRIGGER IF EXISTS update_trend_tag_on_score_change ON shops;
DROP TRIGGER IF EXISTS update_shops_updated_at ON shops;
DROP TRIGGER IF EXISTS update_ads_updated_at ON ads;
DROP TRIGGER IF EXISTS update_subscriptions_updated_at ON subscriptions;
DROP TABLE IF EXISTS brand_alerts CASCADE;
DROP TABLE IF EXISTS tracked_brands CASCADE;
DROP TABLE IF EXISTS user_saved_ads CASCADE;
DROP TABLE IF EXISTS user_saved_shops CASCADE;
DROP TABLE IF EXISTS niche_trends CASCADE;
DROP TABLE IF EXISTS subscriptions CASCADE;
DROP TABLE IF EXISTS ads CASCADE;
DROP TABLE IF EXISTS shops CASCADE;

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- SHOPS TABLE
-- ============================================================================
CREATE TABLE shops (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  domain TEXT UNIQUE NOT NULL,
  niche TEXT,
  score INTEGER DEFAULT 0 CHECK (score >= 0 AND score <= 100),
  trend_tag TEXT CHECK (trend_tag IN ('hot', 'rising', 'watch', 'cold')),
  country TEXT,
  country2 TEXT,
  created_date DATE,
  monthly_visits BIGINT,
  revenue_min INTEGER,
  revenue_max INTEGER,
  live_ads INTEGER DEFAULT 0,
  theme TEXT,
  currency TEXT,
  products_count INTEGER,
  language TEXT,
  shopify_plan TEXT,
  apps TEXT[] DEFAULT '{}',
  ad_platforms TEXT[] DEFAULT '{}',
  strategies TEXT[] DEFAULT '{}',
  visitor_countries TEXT[] DEFAULT '{}',
  traffic_trend INTEGER[] DEFAULT '{}',
  last_scraped TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_shops_domain ON shops(domain);
CREATE INDEX idx_shops_niche ON shops(niche);
CREATE INDEX idx_shops_score ON shops(score DESC);
CREATE INDEX idx_shops_country ON shops(country);
CREATE INDEX idx_shops_monthly_visits ON shops(monthly_visits DESC);
CREATE INDEX idx_shops_trend_tag ON shops(trend_tag);

-- ============================================================================
-- ADS TABLE
-- ============================================================================
CREATE TABLE ads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('meta', 'tiktok', 'google', 'pinterest', 'snapchat', 'instagram', 'youtube')),
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

CREATE INDEX idx_ads_shop_id ON ads(shop_id);
CREATE INDEX idx_ads_platform ON ads(platform);
CREATE INDEX idx_ads_status ON ads(status);
CREATE INDEX idx_ads_detected_at ON ads(detected_at DESC);

-- ============================================================================
-- USER SAVED SHOPS
-- ============================================================================
CREATE TABLE user_saved_shops (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  saved_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, shop_id)
);
CREATE INDEX idx_user_saved_shops_user_id ON user_saved_shops(user_id);

-- ============================================================================
-- USER SAVED ADS
-- ============================================================================
CREATE TABLE user_saved_ads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ad_id UUID NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
  saved_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, ad_id)
);
CREATE INDEX idx_user_saved_ads_user_id ON user_saved_ads(user_id);

-- ============================================================================
-- TRACKED BRANDS
-- ============================================================================
CREATE TABLE tracked_brands (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  alerts_enabled BOOLEAN DEFAULT true,
  tracked_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, shop_id)
);
CREATE INDEX idx_tracked_brands_user_id ON tracked_brands(user_id);

-- ============================================================================
-- BRAND ALERTS
-- ============================================================================
CREATE TABLE brand_alerts (
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
CREATE INDEX idx_brand_alerts_user_id ON brand_alerts(user_id);
CREATE INDEX idx_brand_alerts_created_at ON brand_alerts(created_at DESC);

-- ============================================================================
-- SUBSCRIPTIONS
-- ============================================================================
CREATE TABLE subscriptions (
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
CREATE INDEX idx_subscriptions_user_id ON subscriptions(user_id);

-- ============================================================================
-- NICHE TRENDS
-- ============================================================================
CREATE TABLE niche_trends (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  niche TEXT NOT NULL,
  growth_pct NUMERIC,
  shop_count INTEGER,
  avg_score NUMERIC,
  period TEXT CHECK (period IN ('7d', '30d', '90d')),
  computed_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_niche_trends_period ON niche_trends(period);
CREATE INDEX idx_niche_trends_niche ON niche_trends(niche);

-- ============================================================================
-- RLS POLICIES
-- ============================================================================
ALTER TABLE shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_saved_shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_saved_ads ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracked_brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE brand_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE niche_trends ENABLE ROW LEVEL SECURITY;

-- Shops & Ads: readable by all authenticated users
CREATE POLICY "shops_select_authenticated" ON shops FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "ads_select_authenticated" ON ads FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "niche_trends_select_authenticated" ON niche_trends FOR SELECT USING (auth.role() = 'authenticated');

-- User saved shops
CREATE POLICY "saved_shops_select_own" ON user_saved_shops FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "saved_shops_insert_own" ON user_saved_shops FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "saved_shops_delete_own" ON user_saved_shops FOR DELETE USING (auth.uid() = user_id);

-- User saved ads
CREATE POLICY "saved_ads_select_own" ON user_saved_ads FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "saved_ads_insert_own" ON user_saved_ads FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "saved_ads_delete_own" ON user_saved_ads FOR DELETE USING (auth.uid() = user_id);

-- Tracked brands
CREATE POLICY "tracked_brands_select_own" ON tracked_brands FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "tracked_brands_insert_own" ON tracked_brands FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "tracked_brands_update_own" ON tracked_brands FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "tracked_brands_delete_own" ON tracked_brands FOR DELETE USING (auth.uid() = user_id);

-- Brand alerts
CREATE POLICY "brand_alerts_select_own" ON brand_alerts FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "brand_alerts_update_own" ON brand_alerts FOR UPDATE USING (auth.uid() = user_id);

-- Subscriptions
CREATE POLICY "subscriptions_select_own" ON subscriptions FOR SELECT USING (auth.uid() = user_id);

-- ============================================================================
-- TRIGGERS
-- ============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_shops_updated_at BEFORE UPDATE ON shops FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_ads_updated_at BEFORE UPDATE ON ads FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_subscriptions_updated_at BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- SCORING FUNCTIONS
-- ============================================================================

CREATE OR REPLACE FUNCTION calculate_shop_score(p_shop_id UUID)
RETURNS INTEGER AS $$
DECLARE
  v_score INTEGER := 0;
  v_traffic_growth NUMERIC;
  v_traffic_score INTEGER;
  v_ads_count INTEGER;
  v_ads_score INTEGER;
  v_revenue_min INTEGER;
  v_revenue_max INTEGER;
  v_revenue_midpoint INTEGER;
  v_revenue_score INTEGER;
  v_products_count INTEGER;
  v_products_score INTEGER;
  v_apps_count INTEGER;
  v_apps_score INTEGER;
  v_recent_traffic INTEGER;
  v_previous_traffic INTEGER;
  v_traffic_trend_array INTEGER[];
BEGIN
  SELECT products_count, traffic_trend, revenue_min, revenue_max, COALESCE(array_length(apps, 1), 0)
  INTO v_products_count, v_traffic_trend_array, v_revenue_min, v_revenue_max, v_apps_count
  FROM shops WHERE id = p_shop_id;

  IF NOT FOUND THEN RETURN 0; END IF;

  v_traffic_trend_array := COALESCE(v_traffic_trend_array, ARRAY[]::INTEGER[]);
  v_products_count := COALESCE(v_products_count, 0);
  v_revenue_min := COALESCE(v_revenue_min, 0);
  v_revenue_max := COALESCE(v_revenue_max, 0);

  -- TRAFFIC GROWTH SCORE (30 points max)
  IF array_length(v_traffic_trend_array, 1) >= 8 THEN
    v_recent_traffic := (v_traffic_trend_array[array_length(v_traffic_trend_array, 1)] + v_traffic_trend_array[array_length(v_traffic_trend_array, 1) - 1] + v_traffic_trend_array[array_length(v_traffic_trend_array, 1) - 2] + v_traffic_trend_array[array_length(v_traffic_trend_array, 1) - 3]) / 4;
    v_previous_traffic := (v_traffic_trend_array[array_length(v_traffic_trend_array, 1) - 4] + v_traffic_trend_array[array_length(v_traffic_trend_array, 1) - 5] + v_traffic_trend_array[array_length(v_traffic_trend_array, 1) - 6] + v_traffic_trend_array[array_length(v_traffic_trend_array, 1) - 7]) / 4;
    IF v_previous_traffic > 0 THEN
      v_traffic_growth := ((v_recent_traffic - v_previous_traffic)::NUMERIC / v_previous_traffic) * 100;
    ELSE
      v_traffic_growth := 0;
    END IF;
    IF v_traffic_growth < -20 THEN v_traffic_score := 0;
    ELSIF v_traffic_growth < 0 THEN v_traffic_score := GREATEST(0, CEIL(8 * (v_traffic_growth + 20) / 20))::INTEGER;
    ELSIF v_traffic_growth < 10 THEN v_traffic_score := CEIL(8 + (v_traffic_growth / 10) * 7)::INTEGER;
    ELSIF v_traffic_growth < 30 THEN v_traffic_score := CEIL(15 + ((v_traffic_growth - 10) / 20) * 10)::INTEGER;
    ELSE v_traffic_score := CEIL(25 + LEAST(5, v_traffic_growth - 30))::INTEGER;
    END IF;
    v_traffic_score := LEAST(30, GREATEST(0, v_traffic_score));
  ELSE
    v_traffic_score := 15;
  END IF;

  -- AD COUNT SCORE (20 points max)
  SELECT COUNT(*) INTO v_ads_count FROM ads WHERE shop_id = p_shop_id AND status IN ('active', 'new');
  IF v_ads_count = 0 THEN v_ads_score := 0;
  ELSIF v_ads_count <= 5 THEN v_ads_score := 5;
  ELSIF v_ads_count <= 15 THEN v_ads_score := 10;
  ELSIF v_ads_count <= 30 THEN v_ads_score := 15;
  ELSE v_ads_score := 20;
  END IF;

  -- REVENUE SCORE (20 points max)
  v_revenue_midpoint := ((v_revenue_min + v_revenue_max) / 2);
  IF v_revenue_midpoint < 50000 THEN v_revenue_score := 2;
  ELSIF v_revenue_midpoint < 200000 THEN v_revenue_score := 5;
  ELSIF v_revenue_midpoint < 500000 THEN v_revenue_score := 10;
  ELSIF v_revenue_midpoint < 1000000 THEN v_revenue_score := 15;
  ELSE v_revenue_score := 20;
  END IF;

  -- PRODUCT DIVERSITY SCORE (15 points max)
  IF v_products_count <= 50 THEN v_products_score := 2;
  ELSIF v_products_count <= 150 THEN v_products_score := 5;
  ELSIF v_products_count <= 300 THEN v_products_score := 10;
  ELSE v_products_score := 15;
  END IF;

  -- APP ECOSYSTEM SCORE (15 points max)
  IF v_apps_count <= 3 THEN v_apps_score := 2;
  ELSIF v_apps_count <= 7 THEN v_apps_score := 5;
  ELSIF v_apps_count <= 12 THEN v_apps_score := 10;
  ELSE v_apps_score := 15;
  END IF;

  v_score := v_traffic_score + v_ads_score + v_revenue_score + v_products_score + v_apps_score;
  RETURN GREATEST(0, LEAST(100, v_score));
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION detect_trend_tag(p_score INTEGER)
RETURNS TEXT AS $$
BEGIN
  IF p_score >= 80 THEN RETURN 'hot';
  ELSIF p_score >= 65 THEN RETURN 'rising';
  ELSIF p_score >= 50 THEN RETURN 'watch';
  ELSE RETURN 'cold';
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION trigger_update_trend_tag()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.score IS DISTINCT FROM OLD.score THEN
    NEW.trend_tag := detect_trend_tag(NEW.score);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_trend_tag_on_score_change BEFORE UPDATE ON shops FOR EACH ROW EXECUTE FUNCTION trigger_update_trend_tag();

-- Grant execute to authenticated
GRANT EXECUTE ON FUNCTION calculate_shop_score(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION detect_trend_tag(INTEGER) TO authenticated;
