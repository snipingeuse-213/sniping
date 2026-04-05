-- ============================================================
-- PEEKR — Trending Ads table + scoring
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- ============================================================

-- 1. Drop existing ads table if it exists (fresh start)
DROP TABLE IF EXISTS ads CASCADE;

-- 2. Create the ads table with Meta Ad Library fields
CREATE TABLE ads (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  meta_ad_id    TEXT UNIQUE NOT NULL,
  page_name     TEXT,
  page_id       TEXT,
  shop_domain   TEXT,
  ad_creative_body TEXT,
  ad_snapshot_url  TEXT,
  ad_delivery_start_time DATE,
  eu_total_reach   BIGINT DEFAULT 0,
  impressions_lower BIGINT DEFAULT 0,
  impressions_upper BIGINT DEFAULT 0,
  spend_lower      NUMERIC(12,2) DEFAULT 0,
  spend_upper      NUMERIC(12,2) DEFAULT 0,
  publisher_platforms TEXT[] DEFAULT '{}',
  languages        TEXT[] DEFAULT '{}',
  status           TEXT DEFAULT 'active',
  niche            TEXT,
  running_days     INT GENERATED ALWAYS AS (
    GREATEST(1, CURRENT_DATE - ad_delivery_start_time)
  ) STORED,
  peekr_score      NUMERIC(6,1) DEFAULT 0,
  first_seen_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),

  -- Constraints
  CONSTRAINT valid_status CHECK (status IN ('active','paused','removed'))
);

-- 3. Indexes for fast queries
CREATE INDEX idx_ads_score ON ads (peekr_score DESC);
CREATE INDEX idx_ads_status ON ads (status);
CREATE INDEX idx_ads_niche ON ads (niche);
CREATE INDEX idx_ads_running ON ads (ad_delivery_start_time);
CREATE INDEX idx_ads_reach ON ads (eu_total_reach DESC);

-- 4. Scoring function: longevity x reach explosion x budget scale
CREATE OR REPLACE FUNCTION compute_peekr_score()
RETURNS TRIGGER AS $$
DECLARE
  days_running INT;
  reach_factor NUMERIC;
  spend_factor NUMERIC;
  duration_factor NUMERIC;
  raw_score NUMERIC;
BEGIN
  days_running := GREATEST(1, CURRENT_DATE - NEW.ad_delivery_start_time);
  reach_factor := LN(GREATEST(1, NEW.eu_total_reach) + 1);
  spend_factor := LN(GREATEST(1, COALESCE(NEW.spend_upper, 0)) + 1);
  duration_factor := SQRT(days_running);

  raw_score := reach_factor * duration_factor * (1 + spend_factor * 0.3);
  NEW.peekr_score := LEAST(100, ROUND(raw_score * 2, 1));
  NEW.updated_at := NOW();

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_compute_score
  BEFORE INSERT OR UPDATE ON ads
  FOR EACH ROW
  EXECUTE FUNCTION compute_peekr_score();

-- 5. RLS policy: public read, service_role write
ALTER TABLE ads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can read ads"
  ON ads FOR SELECT
  USING (true);

CREATE POLICY "Service role can insert/update ads"
  ON ads FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Anon can read ads"
  ON ads FOR SELECT TO anon
  USING (true);

-- 6. Grant permissions
GRANT SELECT ON ads TO anon;
GRANT ALL ON ads TO service_role;

-- 7. Updated_at auto-refresh
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- DONE! Now deploy the Edge Function to start importing ads.
-- ============================================================
