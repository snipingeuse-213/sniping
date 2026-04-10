// Trustpilot data proxy - fetches Trustpilot scores server-side to bypass CORS
// GET /api/trustpilot?domain=gymshark.com

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=43200'); // Cache 24h

  const domain = (req.query.domain || '').replace(/^www\./, '').trim();
  if (!domain) {
    return res.status(400).json({ error: 'Missing domain parameter' });
  }

  try {
    // Method 1: Trustpilot business unit search
    const searchUrl = `https://www.trustpilot.com/api/categoriespages/${encodeURIComponent(domain)}`;
    const r1 = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PeekrBot/1.0)',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(8000)
    });

    if (r1.ok) {
      const data = await r1.json();
      if (data && data.trustScore !== undefined) {
        return res.status(200).json({
          domain,
          trustScore: data.trustScore,
          stars: data.stars || Math.round(data.trustScore),
          numberOfReviews: data.numberOfReviews || 0,
          displayName: data.displayName || domain,
          source: 'trustpilot_categories'
        });
      }
    }

    // Method 2: Widget data endpoint
    const widgetUrl = `https://widget.trustpilot.com/trustbox-data/53aa8807dec7e10d38f59f32?businessUnitId=find&locale=en-US&reviewLanguages=all&hostname=${encodeURIComponent(domain)}`;
    const r2 = await fetch(widgetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PeekrBot/1.0)' },
      signal: AbortSignal.timeout(8000)
    });

    if (r2.ok) {
      const data = await r2.json();
      if (data && data.businessEntity) {
        const be = data.businessEntity;
        return res.status(200).json({
          domain,
          trustScore: be.trustScore || 0,
          stars: be.stars || 0,
          numberOfReviews: be.numberOfReviews || 0,
          displayName: be.displayName || domain,
          source: 'trustpilot_widget'
        });
      }
    }

    // Method 3: Direct page scrape for JSON-LD
    const pageUrl = `https://www.trustpilot.com/review/${encodeURIComponent(domain)}`;
    const r3 = await fetch(pageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(8000)
    });

    if (r3.ok) {
      const html = await r3.text();
      // Extract JSON-LD structured data
      const ldMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
      if (ldMatch) {
        try {
          const ld = JSON.parse(ldMatch[1]);
          if (ld && ld.aggregateRating) {
            return res.status(200).json({
              domain,
              trustScore: parseFloat(ld.aggregateRating.ratingValue) || 0,
              stars: Math.round(parseFloat(ld.aggregateRating.ratingValue) || 0),
              numberOfReviews: parseInt(ld.aggregateRating.reviewCount) || 0,
              displayName: ld.name || domain,
              source: 'trustpilot_jsonld'
            });
          }
        } catch (e) {}
      }

      // Fallback: regex extract from page content
      const scoreMatch = html.match(/TrustScore[^0-9]*(\d+\.?\d*)/i);
      const reviewMatch = html.match(/(\d[\d,]*)\s*(?:reviews?|avis)/i);
      if (scoreMatch) {
        return res.status(200).json({
          domain,
          trustScore: parseFloat(scoreMatch[1]) || 0,
          stars: Math.round(parseFloat(scoreMatch[1]) || 0),
          numberOfReviews: reviewMatch ? parseInt(reviewMatch[1].replace(/,/g, '')) : 0,
          displayName: domain,
          source: 'trustpilot_scrape'
        });
      }
    }

    // No data found
    return res.status(200).json({
      domain,
      trustScore: null,
      stars: null,
      numberOfReviews: null,
      displayName: domain,
      source: 'not_found'
    });

  } catch (error) {
    return res.status(200).json({
      domain,
      trustScore: null,
      stars: null,
      numberOfReviews: null,
      error: error.message,
      source: 'error'
    });
  }
};
