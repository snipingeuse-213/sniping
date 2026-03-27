-- Migration: Traffic History for weekly trend tracking
-- Run this in Supabase SQL Editor

-- Table: weekly snapshots of shop traffic
CREATE TABLE IF NOT EXISTS traffic_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  week_start DATE NOT NULL,
  monthly_visits BIGINT,
  estimated_page_views BIGINT,
  estimated_sales BIGINT,
  score INTEGER,
  platform_rank INTEGER,
  global_rank INTEGER,
  products_count INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(domain, week_start)
);

CREATE INDEX IF NOT EXISTS idx_traffic_history_domain ON traffic_history(domain);
CREATE INDEX IF NOT EXISTS idx_traffic_history_week ON traffic_history(week_start DESC);
CREATE INDEX IF NOT EXISTS idx_traffic_history_shop ON traffic_history(shop_id);

-- Function: take a weekly snapshot of all shop traffic
-- Also updates the traffic_trend array on each shop (last 12 weeks)
CREATE OR REPLACE FUNCTION snapshot_traffic()
RETURNS TABLE(snapped INTEGER, week DATE) AS $$
DECLARE
  v_week DATE := date_trunc('week', CURRENT_DATE)::DATE;
  v_count INTEGER := 0;
BEGIN
  INSERT INTO traffic_history (shop_id, domain, week_start, monthly_visits, estimated_page_views, estimated_sales, score, platform_rank, global_rank, products_count)
  SELECT id, domain, v_week, monthly_visits, estimated_page_views, estimated_sales, score, platform_rank, global_rank, products_count
  FROM shops
  WHERE monthly_visits > 0
  ON CONFLICT (domain, week_start) DO UPDATE SET
    monthly_visits = EXCLUDED.monthly_visits,
    estimated_page_views = EXCLUDED.estimated_page_views,
    estimated_sales = EXCLUDED.estimated_sales,
    score = EXCLUDED.score,
    platform_rank = EXCLUDED.platform_rank,
    global_rank = EXCLUDED.global_rank,
    products_count = EXCLUDED.products_count;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Update traffic_trend arrays on shops (last 12 weeks)
  UPDATE shops s SET traffic_trend = sub.trend
  FROM (
    SELECT th.domain,
      array_agg(th.monthly_visits ORDER BY th.week_start ASC) AS trend
    FROM (
      SELECT domain, week_start, monthly_visits
      FROM traffic_history
      WHERE week_start >= (v_week - INTERVAL '11 weeks')
      ORDER BY domain, week_start
    ) th
    GROUP BY th.domain
  ) sub
  WHERE s.domain = sub.domain;

  RETURN QUERY SELECT v_count, v_week;
END;
$$ LANGUAGE plpgsql;
