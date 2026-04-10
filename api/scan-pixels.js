// Pixel Scanner - detects tracking pixels by scraping store HTML
// GET /api/scan-pixels?domain=gymshark.com

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=43200'); // Cache 24h

  const domain = (req.query.domain || '').replace(/^www\./, '').trim();
  if (!domain) {
    return res.status(400).json({ error: 'Missing domain parameter' });
  }

  // Known pixel patterns: script src patterns, inline script patterns, and meta tags
  const PIXEL_SIGNATURES = [
    { name: 'Meta Pixel', patterns: ['connect.facebook.net', 'fbevents.js', 'facebook-jssdk', 'fbq('] },
    { name: 'Google Analytics', patterns: ['google-analytics.com/analytics.js', 'googletagmanager.com/gtag', 'gtag(', 'ga.js', 'analytics.js'] },
    { name: 'Google Tag Manager', patterns: ['googletagmanager.com/gtm.js', 'GTM-'] },
    { name: 'Google Ads', patterns: ['googleads.g.doubleclick.net', 'googlesyndication.com', 'googleadservices.com/pagead', 'gtag(\'config\', \'AW-'] },
    { name: 'TikTok Pixel', patterns: ['analytics.tiktok.com', 'ttq.load'] },
    { name: 'Snap Pixel', patterns: ['sc-static.net/scevent.min.js', 'snaptr('] },
    { name: 'Pinterest Tag', patterns: ['s.pinimg.com/ct/core.js', 'pintrk('] },
    { name: 'Twitter/X Pixel', patterns: ['static.ads-twitter.com', 'twq('] },
    { name: 'LinkedIn Insight', patterns: ['snap.licdn.com/li.lms-analytics', '_linkedin_partner_id'] },
    { name: 'Microsoft Advertising', patterns: ['bat.bing.com', 'UET tag'] },
    { name: 'Criteo', patterns: ['static.criteo.net', 'criteo.com/js'] },
    { name: 'Taboola', patterns: ['cdn.taboola.com', '_tfa.push'] },
    { name: 'Outbrain', patterns: ['outbrain.com/outbrain.js', 'obApi('] },
    { name: 'Hotjar', patterns: ['static.hotjar.com', 'hj('] },
    { name: 'Klaviyo', patterns: ['static.klaviyo.com', 'klaviyo.js'] },
    { name: 'Attentive', patterns: ['attentive.com/tag', 'attn.tv'] },
    { name: 'Postscript', patterns: ['postscript.io', 'ps-widget'] },
    { name: 'Yotpo', patterns: ['staticw2.yotpo.com', 'yotpo.js'] },
    { name: 'Privy', patterns: ['widget.privy.com', 'privy.js'] },
    { name: 'Omnisend', patterns: ['omnisrc.com', 'omnisend'] },
    { name: 'AdRoll', patterns: ['d.adroll.com', 'adroll.com/j/roundtrip'] },
    { name: 'Amazon Ads', patterns: ['amazon-adsystem.com', 'amzn_assoc'] },
    { name: 'DoubleClick', patterns: ['doubleclick.net'] },
    { name: 'Microsoft Clarity', patterns: ['clarity.ms/tag'] },
    { name: 'Shopify Analytics', patterns: ['cdn.shopify.com/s/trekkie', 'trekkie.storefront'] },
  ];

  try {
    // Fetch the store's homepage
    const pageUrl = `https://${domain}`;
    const resp = await fetch(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      signal: AbortSignal.timeout(10000),
      redirect: 'follow'
    });

    if (!resp.ok) {
      return res.status(200).json({ domain, pixels: [], error: 'Store not reachable' });
    }

    const html = await resp.text();
    const htmlLower = html.toLowerCase();

    // Detect pixels
    const detected = [];
    for (const sig of PIXEL_SIGNATURES) {
      for (const pattern of sig.patterns) {
        if (htmlLower.includes(pattern.toLowerCase())) {
          detected.push(sig.name);
          break; // One match per pixel is enough
        }
      }
    }

    return res.status(200).json({
      domain,
      pixels: detected,
      count: detected.length,
      source: 'live_scan'
    });

  } catch (error) {
    return res.status(200).json({
      domain,
      pixels: [],
      error: error.message,
      source: 'error'
    });
  }
};
