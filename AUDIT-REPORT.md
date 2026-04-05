# PEEKR SaaS — Full Audit Report
**Date**: April 5, 2026
**Auditor**: Claude (auto-critical mode)
**Site**: sniping-3nil.vercel.app

---

## SEVERITY LEGEND
- 🔴 **CRITICAL** — Broken feature, blocks users, kills credibility
- 🟠 **HIGH** — Major UX/data issue, must fix before launch
- 🟡 **MEDIUM** — Noticeable problem, fix soon
- 🟢 **LOW** — Polish item, nice-to-have

---

## 🔴 CRITICAL ISSUES (5)

### 1. No way to access Shop Detail from Dashboard
**Page**: peekr-dashboard.html
**Problem**: Clicking a shop name (e.g. "FOREVER 21") opens the EXTERNAL store (www.forever21.com) in a new tab. The domain link does the same. There is NO link to `peekr-shop-detail.html?domain=xxx` anywhere in the dashboard table.
**Impact**: The entire shop analytics feature is unreachable from the main page. Users cannot access the detailed analytics view for any shop.
**Fix**: Shop name should link to `peekr-shop-detail.html?domain={domain}`. The external link icon (↗) next to the domain should open the external store.

### 2. Trending Ads page is completely empty
**Page**: peekr-trending-ads.html
**Problem**: Shows "0 Ads Tracked", "0 Shops Scanned", "No ads match your filters". The entire ads feature returns zero data.
**Impact**: One of the two core features of the SaaS (ads intelligence) is non-functional. The `live_ads` field is 0 for ALL shops in the database.
**Fix**: Either populate the ads table in Supabase or implement the Meta Ads Library scraper to pull live ad data.

### 3. Saved Items page crashes with error
**Page**: peekr-saved.html
**Problem**: Displays "Error Loading Ads — We couldn't load your saved ads. Please try again." with a Reload button that doesn't fix it.
**Impact**: Users who save shops/ads can never retrieve them. The save feature is completely broken.
**Fix**: Debug the Supabase query for `saved_shops` / `saved_ads` tables. Likely a missing table, wrong RLS policy, or auth issue.

### 4. privacy.html is entirely in French
**Page**: privacy.html
**Problem**: Title is "Politique de Confidentialité", all content in French ("Données collectées", "Utilisation des données", "Partage des données", "Sécurité"…).
**Impact**: Peekr targets a US/international audience. A French privacy policy looks unprofessional and may cause legal issues.
**Fix**: Rewrite the entire page in English as "Privacy Policy".

### 5. Overview page has wrong sidebar + placeholder chart
**Page**: peekr-overview.html
**Problem**: Uses a completely different sidebar (Overview/Shops/Ads/Search/Trending/Reports/Favorites/Compete/Export/Premium/Affiliate) that doesn't match ANY other page. The traffic chart is a placeholder ("Chart visualization would appear here"). Different design language (white/blue instead of cream/pink).
**Impact**: Looks like a different product entirely. Breaks user trust.
**Fix**: Rebuild with the standardized sidebar + Peekr design system. Implement real chart using Supabase data.

---

## 🟠 HIGH ISSUES (7)

### 6. Filter tabs don't actually filter data
**Page**: peekr-dashboard.html
**Problem**: Clicking "Top Scaling", "Market Leaders", "Ad Peak", "Traffic Peak" highlights the button but shows the exact same shops in the same order. Only "Weekly Gems" works (redirects to login, which is at least intentional gating).
**Impact**: Filters are a core feature of any analytics dashboard. Fake filters destroy user trust.
**Fix**: Implement actual Supabase queries for each filter (e.g. `order by ads_growth desc` for Top Scaling, `where monthly_visits > 5000000` for Market Leaders).

### 7. Live Ads = 0 for ALL shops
**Page**: peekr-dashboard.html
**Problem**: Every single shop in the database shows "0" in the Live Ads column. The "Spy ads on Meta" links exist but the data field is empty.
**Impact**: A core data point is missing from the entire database. The "Ads Count" performance filter is useless.
**Fix**: Populate `live_ads` field via Meta Ads Library API or manual enrichment.

### 8. Sidebar inconsistency across pages
**Pages**: peekr-overview.html, peekr-saved.html, peekr-community.html, peekr-tools.html
**Problem**: At least 3 different sidebar structures exist:
  - **Standardized** (dashboard, trending-ads, shop-detail): Overview/Analyse/Favorites/Community/Resources/Tools/Account
  - **Old style** (overview): Overview/Shops/Ads/Search/Trending/Reports/Favorites/Compete/Export/Premium/Affiliate
  - **Partial** (saved): Overview/Analyse/Favorites/Tools (missing Community/Resources/Account)
**Impact**: Inconsistent navigation confuses users and looks unfinished.
**Fix**: Apply the standardized sidebar to ALL pages.

### 9. Category data is unreliable
**Page**: peekr-dashboard.html
**Problem**: Gymshark is categorized as "Beauty" (it's sportswear/fitness). Alo Yoga is also "Beauty" (it's athleisure/yoga). Multiple shops likely have wrong categories.
**Impact**: Category filtering becomes useless. Users who filter by "Fashion" or "Sports" won't find relevant shops.
**Fix**: Audit and correct category assignments in Supabase. Consider using Store Leads API category data.

### 10. "Best Trends" and "Export" marked "Soon" but are live pages
**Pages**: peekr-best-trends.html, peekr-export.html
**Problem**: Sidebar shows "Soon" badges but clicking them loads actual pages. Either the features aren't ready (misleading) or they are ready (badge is wrong).
**Impact**: Confusing mixed signals.
**Fix**: Either remove "Soon" badge if features work, or disable the links and show a "Coming Soon" state.

### 11. Shop thumbnails are empty/broken initially
**Page**: peekr-dashboard.html
**Problem**: Shop thumbnail images load via thum.io service and often show blank/loading state. First load shows grey placeholder boxes for all shops.
**Impact**: The dashboard looks empty and unpolished on first impression.
**Fix**: Add a proper fallback (initials avatar like shop-detail does) and consider caching thumbnails.

### 12. No pagination or infinite scroll
**Page**: peekr-dashboard.html
**Problem**: The dashboard claims "856,739 Shops" but only loads a fixed batch. There's no pagination, "Load more" button, or infinite scroll mechanism.
**Impact**: Users can only see the top ~20-30 shops. No way to browse the full catalog.
**Fix**: Implement pagination with Supabase `range()` or offset/limit.

---

## 🟡 MEDIUM ISSUES (8)

### 13. Search shows "+19 from 7.5M catalog" — misleading
**Page**: peekr-dashboard.html
**Problem**: When searching "gymshark", header shows "1 Shops +19 from 7.5M catalog". The "+19" and "7.5M" numbers are confusing — what are the 19 extra results? Is the catalog really 7.5M?
**Impact**: Confusing UX, may seem like a fake number.
**Fix**: Simplify to "1 result found" or explain the +19 (e.g. "19 similar shops").

### 14. peekr-blog.html and peekr-blog-compact.html — duplicate pages
**Pages**: Two blog pages exist
**Problem**: Both blog pages exist in the repo. Which one is canonical?
**Impact**: Maintenance burden, potential confusion.
**Fix**: Keep one, delete the other. Update all links.

### 15. Column sort indicators look non-functional
**Page**: peekr-dashboard.html
**Problem**: Column headers (Monthly Visits, Revenue Est., Score) have sort arrows (↕) but clicking doesn't seem to re-sort the data.
**Impact**: Standard table UX expects clickable sort.
**Fix**: Implement sort functionality via Supabase `order()`.

### 16. "Brand Tracker" marked "Pro" — no upgrade gate
**Page**: peekr-brand-tracker.html
**Problem**: Has a "Pro" badge but the page loads freely with no login or paywall.
**Impact**: No monetization for a premium feature.
**Fix**: Add authentication check + upgrade prompt for non-Pro users.

### 17. Login page doesn't redirect back
**Page**: login.html
**Problem**: When "Weekly Gems" redirects to login, after login there's no redirect back to the dashboard with the filter active.
**Fix**: Pass `?redirect=peekr-dashboard.html&filter=weekly-gems` to login.

### 18. Missing meta tags and OG images
**Pages**: All pages
**Problem**: Pages lack Open Graph tags, Twitter cards, and proper meta descriptions for SEO and social sharing.
**Fix**: Add `<meta property="og:title">`, `og:description`, `og:image`, `twitter:card` to all pages.

### 19. No mobile responsive design
**Pages**: All dashboard pages
**Problem**: The sidebar is fixed 220px with no mobile collapse. On mobile screens, the layout will be completely broken.
**Fix**: Add hamburger menu and responsive sidebar for screens < 768px.

### 20. peekr-community.html and peekr-tools.html have different design
**Pages**: peekr-community.html, peekr-tools.html
**Problem**: These pages use a different sidebar structure and potentially different design tokens.
**Impact**: Breaks the unified feel.
**Fix**: Rebuild with standardized sidebar and Peekr cream/pink design system.

---

## 🟢 LOW ISSUES (5)

### 21. "10,000+ founders worldwide" on landing — unverifiable claim
**Page**: peekr-landing.html
**Fix**: Consider "Join thousands of founders" or add real testimonials.

### 22. Score badge colors inconsistent
**Pages**: dashboard vs shop-detail
**Problem**: Dashboard uses solid pink circles, shop-detail uses color-coded by tier (hot/rising/watch/cold).
**Fix**: Unify score visualization across pages.

### 23. Favicon is emoji-based
**All pages**: Uses inline SVG emoji (👁️) as favicon
**Fix**: Create a proper .ico/.png favicon with the Peekr brand mark.

### 24. No 404 page
**Fix**: Create a branded 404.html for broken links.

### 25. Console: no errors but no performance monitoring
**Fix**: Consider adding error tracking (Sentry) and analytics (Plausible/PostHog).

---

## SUMMARY SCORECARD

| Area | Score | Notes |
|------|-------|-------|
| **Core Navigation** | 3/10 | Shop detail unreachable, sidebar inconsistent across pages |
| **Data Reliability** | 4/10 | Ads data missing, categories wrong, filters don't work |
| **Design Consistency** | 5/10 | 3 pages standardized, 5+ pages use old/different design |
| **Feature Completeness** | 3/10 | Ads empty, saved broken, filters fake, no pagination |
| **Language/i18n** | 7/10 | privacy.html in French, rest in English |
| **Landing/Marketing** | 8/10 | Clean, professional, good copy |
| **Technical Health** | 7/10 | No console errors, fast loads, but no auth/security |
| **Mobile/Responsive** | 2/10 | Not responsive at all |

**OVERALL: 4.9/10** — The SaaS has a strong visual identity and good data foundation, but critical features are broken or incomplete. The priority fix order should be: (1) Shop detail navigation, (2) Standardize all sidebars, (3) Fix saved items, (4) Translate privacy.html, (5) Populate ads data, (6) Implement real filters.

---

## PRIORITY FIX ORDER

1. 🔴 Fix shop name links → shop-detail page (not external store)
2. 🔴 Translate privacy.html to English
3. 🔴 Fix saved items page error
4. 🔴 Standardize sidebar on ALL pages
5. 🔴 Rebuild overview page with correct design
6. 🟠 Implement working filter tabs
7. 🟠 Populate live_ads data
8. 🟠 Fix category assignments
9. 🟠 Add pagination
10. 🟡 Add mobile responsive design
