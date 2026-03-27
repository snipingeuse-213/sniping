-- Migration: Adapt shops table for Store Leads data
-- Run this in Supabase SQL Editor

-- Add new columns from Store Leads
ALTER TABLE shops ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS merchant_name TEXT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS estimated_sales BIGINT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS estimated_sales_yearly BIGINT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS platform_rank INTEGER;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS global_rank INTEGER;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS rank_percentile FLOAT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS avg_price_usd INTEGER; -- in cents
ALTER TABLE shops ADD COLUMN IF NOT EXISTS monthly_app_spend INTEGER; -- in cents
ALTER TABLE shops ADD COLUMN IF NOT EXISTS employee_count INTEGER;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS categories TEXT[] DEFAULT '{}';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS technologies TEXT[] DEFAULT '{}';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS region TEXT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS icon TEXT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS storeleads_updated_at TIMESTAMPTZ;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS vendor_count INTEGER;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS variant_count INTEGER;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS estimated_page_views BIGINT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS ships_to TEXT[] DEFAULT '{}';

-- Add indexes for new columns
CREATE INDEX IF NOT EXISTS idx_shops_platform_rank ON shops(platform_rank ASC);
CREATE INDEX IF NOT EXISTS idx_shops_global_rank ON shops(global_rank ASC);
CREATE INDEX IF NOT EXISTS idx_shops_estimated_sales ON shops(estimated_sales DESC);
CREATE INDEX IF NOT EXISTS idx_shops_categories ON shops USING gin(categories);

-- Update the score calculation function to use real data
CREATE OR REPLACE FUNCTION calculate_shop_score(shop_row shops) RETURNS INTEGER AS $$
DECLARE
  v_score FLOAT := 0;
  v_visits BIGINT;
  v_sales BIGINT;
  v_rank INTEGER;
  v_products INTEGER;
  v_apps INTEGER;
BEGIN
  v_visits := COALESCE(shop_row.monthly_visits, 0);
  v_sales := COALESCE(shop_row.estimated_sales, 0);
  v_rank := COALESCE(shop_row.platform_rank, 999999);
  v_products := COALESCE(shop_row.products_count, 0);
  v_apps := COALESCE(array_length(shop_row.apps, 1), 0);

  -- Traffic score (0-30 pts)
  IF v_visits > 1000000 THEN v_score := v_score + 30;
  ELSIF v_visits > 500000 THEN v_score := v_score + 25;
  ELSIF v_visits > 100000 THEN v_score := v_score + 20;
  ELSIF v_visits > 50000 THEN v_score := v_score + 15;
  ELSIF v_visits > 10000 THEN v_score := v_score + 10;
  ELSIF v_visits > 1000 THEN v_score := v_score + 5;
  END IF;

  -- Revenue score (0-25 pts)
  IF v_sales > 10000000 THEN v_score := v_score + 25;
  ELSIF v_sales > 1000000 THEN v_score := v_score + 20;
  ELSIF v_sales > 500000 THEN v_score := v_score + 15;
  ELSIF v_sales > 100000 THEN v_score := v_score + 10;
  ELSIF v_sales > 10000 THEN v_score := v_score + 5;
  END IF;

  -- Platform rank score (0-20 pts)
  IF v_rank <= 100 THEN v_score := v_score + 20;
  ELSIF v_rank <= 500 THEN v_score := v_score + 16;
  ELSIF v_rank <= 2000 THEN v_score := v_score + 12;
  ELSIF v_rank <= 10000 THEN v_score := v_score + 8;
  ELSIF v_rank <= 50000 THEN v_score := v_score + 4;
  END IF;

  -- Products score (0-15 pts)
  IF v_products > 1000 THEN v_score := v_score + 15;
  ELSIF v_products > 500 THEN v_score := v_score + 12;
  ELSIF v_products > 100 THEN v_score := v_score + 9;
  ELSIF v_products > 20 THEN v_score := v_score + 6;
  ELSIF v_products > 5 THEN v_score := v_score + 3;
  END IF;

  -- Apps score (0-10 pts)
  IF v_apps > 10 THEN v_score := v_score + 10;
  ELSIF v_apps > 5 THEN v_score := v_score + 7;
  ELSIF v_apps > 2 THEN v_score := v_score + 4;
  ELSIF v_apps > 0 THEN v_score := v_score + 2;
  END IF;

  RETURN LEAST(GREATEST(ROUND(v_score), 0), 100)::INTEGER;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Update trend_tag based on score
CREATE OR REPLACE FUNCTION detect_trend_tag(score INTEGER) RETURNS TEXT AS $$
BEGIN
  IF score >= 75 THEN RETURN 'hot';
  ELSIF score >= 55 THEN RETURN 'rising';
  ELSIF score >= 35 THEN RETURN 'watch';
  ELSE RETURN 'cold';
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
