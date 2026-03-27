-- Peekr Scoring Algorithm
-- PL/pgSQL functions for shop scoring and intelligence metrics

-- ============================================================================
-- SCORING FUNCTION: calculate_shop_score
-- ============================================================================
-- Composite score 0-100 based on:
-- - Traffic growth (last 4 weeks vs previous 4): 30 points
-- - Ad count: 20 points
-- - Revenue estimate: 20 points
-- - Product diversity: 15 points
-- - App ecosystem: 15 points

CREATE OR REPLACE FUNCTION calculate_shop_score(
  p_shop_id UUID
)
RETURNS INTEGER AS $$
DECLARE
  v_score INTEGER := 0;
  v_traffic_growth NUMERIC;
  v_traffic_score INTEGER;
  v_ads_count INTEGER;
  v_ads_score INTEGER;
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

  -- Get current shop data
  SELECT
    products_count,
    traffic_trend,
    revenue_min,
    revenue_max,
    array_length(apps, 1)
  INTO
    v_products_count,
    v_traffic_trend_array,
    v_revenue_min,
    v_revenue_max,
    v_apps_count
  FROM shops
  WHERE id = p_shop_id;

  -- If shop not found, return 0
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  -- Handle null values
  v_traffic_trend_array := COALESCE(v_traffic_trend_array, ARRAY[]::INTEGER[]);
  v_products_count := COALESCE(v_products_count, 0);
  v_apps_count := COALESCE(v_apps_count, 0);

  -- ========================================================================
  -- TRAFFIC GROWTH SCORE (30 points max)
  -- ========================================================================
  -- Last 4 weeks average vs previous 4 weeks average
  -- Calculate only if we have at least 8 data points

  IF array_length(v_traffic_trend_array, 1) >= 8 THEN
    -- Last 4 weeks (most recent)
    v_recent_traffic := (
      COALESCE(v_traffic_trend_array[array_length(v_traffic_trend_array, 1)], 0) +
      COALESCE(v_traffic_trend_array[array_length(v_traffic_trend_array, 1) - 1], 0) +
      COALESCE(v_traffic_trend_array[array_length(v_traffic_trend_array, 1) - 2], 0) +
      COALESCE(v_traffic_trend_array[array_length(v_traffic_trend_array, 1) - 3], 0)
    ) / 4;

    -- Previous 4 weeks
    v_previous_traffic := (
      COALESCE(v_traffic_trend_array[array_length(v_traffic_trend_array, 1) - 4], 0) +
      COALESCE(v_traffic_trend_array[array_length(v_traffic_trend_array, 1) - 5], 0) +
      COALESCE(v_traffic_trend_array[array_length(v_traffic_trend_array, 1) - 6], 0) +
      COALESCE(v_traffic_trend_array[array_length(v_traffic_trend_array, 1) - 7], 0)
    ) / 4;

    -- Calculate growth percentage
    IF v_previous_traffic > 0 THEN
      v_traffic_growth := ((v_recent_traffic - v_previous_traffic) / v_previous_traffic) * 100;
    ELSE
      v_traffic_growth := 0;
    END IF;

    -- Score calculation: cap at 30 points
    -- Growth categories:
    -- < -20%: 0 points (declining)
    -- -20% to 0%: 0-8 points (stagnant)
    -- 0% to 10%: 8-15 points (steady)
    -- 10% to 30%: 15-25 points (growing)
    -- > 30%: 25-30 points (strong growth)

    IF v_traffic_growth < -20 THEN
      v_traffic_score := 0;
    ELSIF v_traffic_growth < 0 THEN
      v_traffic_score := GREATEST(0, CEIL(8 * (v_traffic_growth + 20) / 20));
    ELSIF v_traffic_growth < 10 THEN
      v_traffic_score := CEIL(8 + (v_traffic_growth / 10) * 7);
    ELSIF v_traffic_growth < 30 THEN
      v_traffic_score := CEIL(15 + ((v_traffic_growth - 10) / 20) * 10);
    ELSE
      v_traffic_score := CEIL(25 + LEAST(5, v_traffic_growth - 30));
    END IF;

    v_traffic_score := LEAST(30, GREATEST(0, v_traffic_score));
  ELSE
    -- Not enough data, use 15 points (neutral)
    v_traffic_score := 15;
  END IF;

  -- ========================================================================
  -- AD COUNT SCORE (20 points max)
  -- ========================================================================
  -- Count active and new ads for this shop

  SELECT COUNT(*)
  INTO v_ads_count
  FROM ads
  WHERE shop_id = p_shop_id AND status IN ('active', 'new');

  -- Score: 0-20 based on ad count
  -- 0 ads: 0 points
  -- 1-5 ads: 5 points
  -- 6-15 ads: 10 points
  -- 16-30 ads: 15 points
  -- 30+ ads: 20 points

  IF v_ads_count = 0 THEN
    v_ads_score := 0;
  ELSIF v_ads_count <= 5 THEN
    v_ads_score := 5;
  ELSIF v_ads_count <= 15 THEN
    v_ads_score := 10;
  ELSIF v_ads_count <= 30 THEN
    v_ads_score := 15;
  ELSE
    v_ads_score := 20;
  END IF;

  -- ========================================================================
  -- REVENUE ESTIMATE SCORE (20 points max)
  -- ========================================================================
  -- Based on revenue range midpoint

  v_revenue_midpoint := ((v_revenue_min + v_revenue_max) / 2)::INTEGER;

  -- Score: based on estimated monthly revenue
  -- <$50k: 2 points
  -- $50k-$200k: 5 points
  -- $200k-$500k: 10 points
  -- $500k-$1M: 15 points
  -- $1M+: 20 points

  IF v_revenue_midpoint < 50000 THEN
    v_revenue_score := 2;
  ELSIF v_revenue_midpoint < 200000 THEN
    v_revenue_score := 5;
  ELSIF v_revenue_midpoint < 500000 THEN
    v_revenue_score := 10;
  ELSIF v_revenue_midpoint < 1000000 THEN
    v_revenue_score := 15;
  ELSE
    v_revenue_score := 20;
  END IF;

  -- ========================================================================
  -- PRODUCT DIVERSITY SCORE (15 points max)
  -- ========================================================================
  -- Based on product count
  -- 0-50 products: 2 points
  -- 51-150 products: 5 points
  -- 151-300 products: 10 points
  -- 300+ products: 15 points

  IF v_products_count <= 50 THEN
    v_products_score := 2;
  ELSIF v_products_count <= 150 THEN
    v_products_score := 5;
  ELSIF v_products_count <= 300 THEN
    v_products_score := 10;
  ELSE
    v_products_score := 15;
  END IF;

  -- ========================================================================
  -- APP ECOSYSTEM SCORE (15 points max)
  -- ========================================================================
  -- Based on number of apps installed
  -- 0-3 apps: 2 points
  -- 4-7 apps: 5 points
  -- 8-12 apps: 10 points
  -- 13+ apps: 15 points

  IF v_apps_count <= 3 THEN
    v_apps_score := 2;
  ELSIF v_apps_count <= 7 THEN
    v_apps_score := 5;
  ELSIF v_apps_count <= 12 THEN
    v_apps_score := 10;
  ELSE
    v_apps_score := 15;
  END IF;

  -- ========================================================================
  -- CALCULATE FINAL SCORE
  -- ========================================================================
  -- Sum all component scores and ensure it's within 0-100 range

  v_score := v_traffic_score + v_ads_score + v_revenue_score +
             v_products_score + v_apps_score;

  -- Ensure score is within valid range
  v_score := GREATEST(0, LEAST(100, v_score));

  RETURN v_score;

END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================================================
-- FUNCTION: update_shop_score
-- ============================================================================
-- Updates a single shop's score in the database

CREATE OR REPLACE FUNCTION update_shop_score(p_shop_id UUID)
RETURNS INTEGER AS $$
DECLARE
  v_new_score INTEGER;
BEGIN
  v_new_score := calculate_shop_score(p_shop_id);

  UPDATE shops
  SET score = v_new_score, updated_at = NOW()
  WHERE id = p_shop_id;

  RETURN v_new_score;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FUNCTION: recalculate_all_shop_scores
-- ============================================================================
-- Batch recalculate all shop scores. Returns count of shops updated.

CREATE OR REPLACE FUNCTION recalculate_all_shop_scores()
RETURNS TABLE(shops_updated INTEGER, avg_score NUMERIC, min_score INTEGER, max_score INTEGER) AS $$
DECLARE
  v_count INTEGER := 0;
  v_avg NUMERIC;
  v_min INTEGER;
  v_max INTEGER;
  v_shop_id UUID;
BEGIN

  -- Iterate through all shops and update their scores
  FOR v_shop_id IN SELECT id FROM shops LOOP
    PERFORM update_shop_score(v_shop_id);
    v_count := v_count + 1;
  END LOOP;

  -- Calculate statistics
  SELECT
    COUNT(*),
    ROUND(AVG(score)::NUMERIC, 2),
    MIN(score),
    MAX(score)
  INTO
    v_count,
    v_avg,
    v_min,
    v_max
  FROM shops;

  RETURN QUERY SELECT v_count, v_avg, v_min, v_max;

END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FUNCTION: get_trending_niches
-- ============================================================================
-- Returns trending niches with growth metrics for a given period

CREATE OR REPLACE FUNCTION get_trending_niches(
  p_period TEXT DEFAULT '30d'
)
RETURNS TABLE(
  niche TEXT,
  shop_count INTEGER,
  avg_score NUMERIC,
  hot_count INTEGER,
  rising_count INTEGER,
  watch_count INTEGER,
  cold_count INTEGER,
  trend_score NUMERIC
) AS $$
BEGIN

  RETURN QUERY
  SELECT
    s.niche,
    COUNT(*)::INTEGER as shop_count,
    ROUND(AVG(s.score)::NUMERIC, 1) as avg_score,
    COUNT(CASE WHEN s.trend_tag = 'hot' THEN 1 END)::INTEGER,
    COUNT(CASE WHEN s.trend_tag = 'rising' THEN 1 END)::INTEGER,
    COUNT(CASE WHEN s.trend_tag = 'watch' THEN 1 END)::INTEGER,
    COUNT(CASE WHEN s.trend_tag = 'cold' THEN 1 END)::INTEGER,
    -- Trend score: weight hot(3) + rising(2) + watch(1) + cold(0)
    ROUND((
      COUNT(CASE WHEN s.trend_tag = 'hot' THEN 1 END) * 3 +
      COUNT(CASE WHEN s.trend_tag = 'rising' THEN 1 END) * 2 +
      COUNT(CASE WHEN s.trend_tag = 'watch' THEN 1 END) * 1
    )::NUMERIC / NULLIF(COUNT(*), 0), 2) as trend_score
  FROM shops s
  WHERE s.niche IS NOT NULL
  GROUP BY s.niche
  ORDER BY COUNT(*) DESC, ROUND(AVG(s.score), 1) DESC;

END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FUNCTION: get_shop_metrics
-- ============================================================================
-- Returns comprehensive metrics for a specific shop

CREATE OR REPLACE FUNCTION get_shop_metrics(p_shop_id UUID)
RETURNS TABLE(
  shop_id UUID,
  shop_name TEXT,
  score INTEGER,
  monthly_visits BIGINT,
  revenue_estimate BIGINT,
  product_count INTEGER,
  active_ads_count INTEGER,
  app_count INTEGER,
  avg_ad_engagement NUMERIC,
  traffic_trend_slope NUMERIC
) AS $$
DECLARE
  v_traffic_trend_array INTEGER[];
  v_min_visits INTEGER;
  v_max_visits INTEGER;
  v_trend_slope NUMERIC;
BEGIN

  -- Get traffic trend array
  SELECT traffic_trend INTO v_traffic_trend_array FROM shops WHERE id = p_shop_id;

  -- Calculate trend slope (simple linear regression approximation)
  IF array_length(v_traffic_trend_array, 1) >= 2 THEN
    SELECT
      (v_traffic_trend_array[array_length(v_traffic_trend_array, 1)] - v_traffic_trend_array[1])::NUMERIC /
      (array_length(v_traffic_trend_array, 1) - 1)
    INTO v_trend_slope;
  ELSE
    v_trend_slope := 0;
  END IF;

  RETURN QUERY
  SELECT
    s.id,
    s.name,
    s.score,
    s.monthly_visits,
    ((s.revenue_min + s.revenue_max) / 2)::BIGINT,
    s.products_count,
    (SELECT COUNT(*) FROM ads WHERE shop_id = p_shop_id AND status IN ('active', 'new'))::INTEGER,
    array_length(s.apps, 1)::INTEGER,
    (SELECT ROUND(AVG(likes + shares)::NUMERIC, 2) FROM ads WHERE shop_id = p_shop_id),
    v_trend_slope
  FROM shops s
  WHERE s.id = p_shop_id;

END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FUNCTION: detect_trend_tag
-- ============================================================================
-- Automatically assigns trend tag (hot, rising, watch, cold) based on score

CREATE OR REPLACE FUNCTION detect_trend_tag(p_score INTEGER)
RETURNS TEXT AS $$
BEGIN
  CASE
    WHEN p_score >= 80 THEN RETURN 'hot';
    WHEN p_score >= 65 THEN RETURN 'rising';
    WHEN p_score >= 50 THEN RETURN 'watch';
    ELSE RETURN 'cold';
  END CASE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================================================
-- FUNCTION: update_shop_trend_tag
-- ============================================================================
-- Updates trend_tag based on current score

CREATE OR REPLACE FUNCTION update_shop_trend_tag(p_shop_id UUID)
RETURNS TEXT AS $$
DECLARE
  v_score INTEGER;
  v_tag TEXT;
BEGIN
  SELECT score INTO v_score FROM shops WHERE id = p_shop_id;
  v_tag := detect_trend_tag(v_score);

  UPDATE shops SET trend_tag = v_tag, updated_at = NOW()
  WHERE id = p_shop_id;

  RETURN v_tag;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- TRIGGER: auto_update_trend_tag_on_score_change
-- ============================================================================
-- Automatically updates trend_tag when score changes

CREATE OR REPLACE FUNCTION trigger_update_trend_tag()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.score != OLD.score THEN
    NEW.trend_tag := detect_trend_tag(NEW.score);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_trend_tag_on_score_change ON shops;
CREATE TRIGGER update_trend_tag_on_score_change
  BEFORE UPDATE ON shops
  FOR EACH ROW
  EXECUTE FUNCTION trigger_update_trend_tag();

-- ============================================================================
-- FUNCTION: compute_niche_trends
-- ============================================================================
-- Computes and stores niche trend statistics for analytics

CREATE OR REPLACE FUNCTION compute_niche_trends(p_period TEXT DEFAULT '30d')
RETURNS TABLE(
  niche_name TEXT,
  growth_pct NUMERIC,
  shop_count INTEGER,
  avg_score NUMERIC
) AS $$
BEGIN

  DELETE FROM niche_trends WHERE period = p_period;

  INSERT INTO niche_trends (niche, growth_pct, shop_count, avg_score, period)
  SELECT
    s.niche,
    -- Growth percentage based on hot/rising shop ratio
    ROUND((
      (COUNT(CASE WHEN s.trend_tag IN ('hot', 'rising') THEN 1 END)::NUMERIC / COUNT(*)) * 100
    ), 2) as growth_pct,
    COUNT(*)::INTEGER as shop_count,
    ROUND(AVG(s.score)::NUMERIC, 2) as avg_score
  FROM shops s
  WHERE s.niche IS NOT NULL
  GROUP BY s.niche;

  RETURN QUERY
  SELECT
    nt.niche,
    nt.growth_pct,
    nt.shop_count,
    nt.avg_score
  FROM niche_trends nt
  WHERE nt.period = p_period
  ORDER BY nt.growth_pct DESC;

END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- HELPER FUNCTIONS FOR ANALYTICS
-- ============================================================================

-- Get shops by score tier
CREATE OR REPLACE FUNCTION get_shops_by_tier(p_tier TEXT)
RETURNS TABLE(
  id UUID,
  name TEXT,
  domain TEXT,
  score INTEGER,
  niche TEXT,
  monthly_visits BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.id,
    s.name,
    s.domain,
    s.score,
    s.niche,
    s.monthly_visits
  FROM shops s
  WHERE
    CASE
      WHEN p_tier = 'elite' THEN s.score >= 85
      WHEN p_tier = 'strong' THEN s.score >= 70 AND s.score < 85
      WHEN p_tier = 'emerging' THEN s.score >= 50 AND s.score < 70
      WHEN p_tier = 'new' THEN s.score < 50
      ELSE FALSE
    END
  ORDER BY s.score DESC, s.monthly_visits DESC;
END;
$$ LANGUAGE plpgsql;

-- Calculate niche health score
CREATE OR REPLACE FUNCTION get_niche_health(p_niche TEXT)
RETURNS TABLE(
  niche TEXT,
  health_score NUMERIC,
  shop_count INTEGER,
  avg_traffic BIGINT,
  momentum TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.niche,
    ROUND(AVG(s.score)::NUMERIC, 1) as health_score,
    COUNT(*)::INTEGER as shop_count,
    ROUND(AVG(s.monthly_visits))::BIGINT as avg_traffic,
    CASE
      WHEN COUNT(CASE WHEN s.trend_tag = 'hot' THEN 1 END)::NUMERIC / COUNT(*) > 0.4 THEN 'Accelerating'
      WHEN COUNT(CASE WHEN s.trend_tag = 'rising' THEN 1 END)::NUMERIC / COUNT(*) > 0.4 THEN 'Growing'
      WHEN COUNT(CASE WHEN s.trend_tag = 'watch' THEN 1 END)::NUMERIC / COUNT(*) > 0.4 THEN 'Stable'
      ELSE 'Declining'
    END as momentum
  FROM shops s
  WHERE s.niche = p_niche
  GROUP BY s.niche;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- GRANTS FOR AUTHENTICATED USERS
-- ============================================================================
-- Allow authenticated users to call public functions

GRANT EXECUTE ON FUNCTION calculate_shop_score(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION get_trending_niches(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION get_shop_metrics(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION get_shops_by_tier(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION get_niche_health(TEXT) TO authenticated;

-- ============================================================================
-- COMMENTS FOR DOCUMENTATION
-- ============================================================================

COMMENT ON FUNCTION calculate_shop_score(UUID) IS
'Calculates composite shop score (0-100) based on traffic growth (30), ad count (20), revenue (20), product diversity (15), and app ecosystem (15).';

COMMENT ON FUNCTION update_shop_score(UUID) IS
'Updates a single shop''s score and returns the new score value.';

COMMENT ON FUNCTION recalculate_all_shop_scores() IS
'Batch recalculates scores for all shops. Returns count, average, min, and max scores.';

COMMENT ON FUNCTION get_trending_niches(TEXT) IS
'Returns trending niches with shop counts, average scores, and distribution by trend tag for the specified period.';

COMMENT ON FUNCTION get_shop_metrics(UUID) IS
'Returns comprehensive metrics for a shop including traffic trend slope and average ad engagement.';

COMMENT ON FUNCTION detect_trend_tag(INTEGER) IS
'Determines trend tag (hot, rising, watch, cold) based on score: hot>=80, rising>=65, watch>=50, cold<50.';

COMMENT ON FUNCTION compute_niche_trends(TEXT) IS
'Computes and stores niche trend statistics. Called periodically to update niche_trends table.';

-- ============================================================================
-- INITIALIZATION: Calculate scores for all existing shops
-- ============================================================================
-- Uncomment to run after inserting seed data:
-- SELECT recalculate_all_shop_scores();
-- SELECT compute_niche_trends('30d');
