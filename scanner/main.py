"""
SNIPING Scanner - Shopify Store Analyzer
Scans Shopify stores, extracts metadata, scores them, and stores results in Supabase.
"""

import os
import re
import json
import asyncio
import hashlib
from datetime import datetime, timezone
from typing import Optional

import aiohttp
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv()

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

SUPABASE_REST = f"{SUPABASE_URL}/rest/v1" if SUPABASE_URL else ""
HEADERS = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "resolution=merge-duplicates",
} if SUPABASE_SERVICE_KEY else {}


def _check_supabase():
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        raise HTTPException(status_code=503, detail="SUPABASE_URL and SUPABASE_SERVICE_KEY not configured")

# Known Shopify apps & pixel signatures
KNOWN_APPS = {
    "klaviyo": "Klaviyo", "loox": "Loox", "judge.me": "Judge.me",
    "yotpo": "Yotpo", "reconvert": "ReConvert", "gempages": "GemPages",
    "pagefly": "PageFly", "aftership": "AfterShip", "tidio": "Tidio",
    "hotjar": "Hotjar", "lucky-orange": "Lucky Orange", "fomo": "FOMO",
    "smile.io": "Smile.io", "bold": "Bold Upsell", "carthook": "CartHook",
    "mailchimp": "Mailchimp", "privy": "Privy", "omnisend": "Omnisend",
    "stamped": "Stamped.io", "vitals": "Vitals", "dsers": "DSers",
    "oberlo": "Oberlo", "spocket": "Spocket", "cjdropshipping": "CJ Dropshipping",
}

PIXEL_PATTERNS = {
    "fbevents.js": "Meta Pixel",
    "facebook.com/tr": "Meta Pixel",
    "analytics.tiktok.com": "TikTok Pixel",
    "tiktok.com/i18n/pixel": "TikTok Pixel",
    "googleads.g.doubleclick": "Google Ads",
    "google-analytics.com": "Google Analytics",
    "gtag/js": "Google Ads",
    "pintrk": "Pinterest",
    "snap.licdn.com": "LinkedIn",
    "sc-static.net/scevent.min.js": "Snapchat",
}

ALIEXPRESS_HINTS = [
    "aliexpress", "dsers", "oberlo", "cjdropshipping", "spocket",
    "dropship", "zendrop", "autods",
]

COUNTRY_FLAGS = {
    "USD": ("US", "US"), "EUR": ("FR", "FR"), "GBP": ("GB", "UK"),
    "CAD": ("CA", "CA"), "AUD": ("AU", "AU"), "JPY": ("JP", "JP"),
    "SEK": ("SE", "SE"), "NOK": ("NO", "NO"), "DKK": ("DK", "DK"),
    "CHF": ("CH", "CH"), "NZD": ("NZ", "NZ"), "BRL": ("BR", "BR"),
}

app = FastAPI(title="SNIPING Scanner", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class ScanRequest(BaseModel):
    domain: str


class BatchScanRequest(BaseModel):
    domains: list[str]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _flag(code: str) -> str:
    """Convert 2-letter country code to flag emoji."""
    return "".join(chr(0x1F1E6 + ord(c) - ord("A")) for c in code.upper()[:2])


def _score_shop(data: dict) -> tuple[int, str]:
    """Compute a 0-100 score and tier label."""
    s = 0
    s += min(len(data.get("apps", [])) * 5, 25)
    s += min(len(data.get("pixels", [])) * 8, 24)
    s += min(data.get("product_count", 0), 20)
    if data.get("theme") and data["theme"] != "Unknown":
        s += 8
    if not data.get("has_aliexpress"):
        s += 8
    s += min(len(data.get("top_products", [])) * 5, 15)
    s = min(s, 100)

    if s >= 80:
        tier = "HOT"
    elif s >= 55:
        tier = "RISING"
    elif s >= 35:
        tier = "WATCH"
    else:
        tier = "COLD"
    return s, tier


TIER_EMOJI = {"HOT": "HOT", "RISING": "RISING", "WATCH": "WATCH", "COLD": "COLD"}


async def _fetch(session: aiohttp.ClientSession, url: str) -> Optional[str]:
    """GET a URL, return text or None on failure."""
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
            if resp.status == 200:
                return await resp.text()
    except Exception:
        pass
    return None


async def _fetch_json(session: aiohttp.ClientSession, url: str):
    """GET a URL, return parsed JSON or None."""
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
            if resp.status == 200:
                return await resp.json(content_type=None)
    except Exception:
        pass
    return None


def _detect_theme(html: str) -> str:
    """Extract the Shopify theme name from HTML."""
    patterns = [
        r'Shopify\.theme\s*=\s*\{[^}]*"name"\s*:\s*"([^"]+)"',
        r'data-theme-name="([^"]+)"',
        r'theme_name["\s:]+["\']([^"\']+)',
    ]
    for pat in patterns:
        m = re.search(pat, html)
        if m:
            return m.group(1)
    return "Unknown"


def _detect_apps(html: str) -> list[str]:
    """Detect known Shopify apps from page HTML."""
    lower = html.lower()
    found = []
    for sig, name in KNOWN_APPS.items():
        if sig in lower and name not in found:
            found.append(name)
    return found


def _detect_pixels(html: str) -> list[str]:
    """Detect tracking pixels from page HTML."""
    lower = html.lower()
    found = []
    for sig, name in PIXEL_PATTERNS.items():
        if sig.lower() in lower and name not in found:
            found.append(name)
    return found


def _detect_aliexpress(html: str, apps: list[str]) -> bool:
    """Check for AliExpress / dropshipping signals."""
    lower = html.lower()
    for hint in ALIEXPRESS_HINTS:
        if hint in lower:
            return True
    drop_apps = {"DSers", "Oberlo", "Spocket", "CJ Dropshipping"}
    return bool(drop_apps & set(apps))


def _freshness_label() -> str:
    return "just now"


# ---------------------------------------------------------------------------
# Core scanner
# ---------------------------------------------------------------------------
async def scan_store(domain: str) -> dict:
    """Scan a single Shopify store and return structured data."""
    domain = domain.strip().lower()
    if domain.startswith("http"):
        domain = domain.split("//")[1].split("/")[0]

    base = f"https://{domain}"

    async with aiohttp.ClientSession(
        headers={"User-Agent": "Mozilla/5.0 (compatible; SnipingBot/1.0)"}
    ) as session:
        html_task = _fetch(session, base)
        products_task = _fetch_json(session, f"{base}/products.json?limit=250")
        meta_task = _fetch_json(session, f"{base}/meta.json")

        html, products_data, meta_data = await asyncio.gather(
            html_task, products_task, meta_task
        )

    if not html:
        raise HTTPException(status_code=400, detail=f"Cannot reach {domain}")

    # Parse
    theme = _detect_theme(html)
    apps = _detect_apps(html)
    pixels = _detect_pixels(html)
    has_aliexpress = _detect_aliexpress(html, apps)

    # Products
    products = []
    product_count = 0
    if products_data and "products" in products_data:
        raw = products_data["products"]
        product_count = len(raw)
        for p in sorted(raw, key=lambda x: x.get("id", 0), reverse=True)[:5]:
            price = "0"
            if p.get("variants"):
                price = p["variants"][0].get("price", "0")
            products.append({
                "title": p.get("title", "Unknown"),
                "price": price,
                "orders": 0,
            })

    # Meta / currency
    currency = "USD"
    shop_name = domain.split(".")[0].replace("-", " ").title()
    if meta_data:
        currency = meta_data.get("currency", "USD")
        shop_name = meta_data.get("name", shop_name)

    # Country
    cc = COUNTRY_FLAGS.get(currency, ("US", "US"))
    country = f"{_flag(cc[0])} {cc[1]}"

    # Niche detection (simple keyword-based)
    lower_html = html.lower()
    niche = "general"
    niche_keywords = {
        "beauty": ["skincare", "serum", "makeup", "cosmetic", "beauty", "glow", "lip"],
        "fitness": ["fitness", "workout", "gym", "yoga", "resistance", "protein"],
        "jewelry": ["jewelry", "jewellery", "necklace", "ring", "bracelet", "earring"],
        "pets": ["dog", "cat", "pet", "puppy", "kitten", "leash", "harness"],
        "home": ["kitchen", "home", "decor", "furniture", "candle", "blanket"],
        "fashion": ["dress", "clothing", "apparel", "fashion", "shirt", "hoodie"],
        "tech": ["phone", "charger", "gadget", "electronic", "smart", "wireless"],
    }
    best_count = 0
    for n, kws in niche_keywords.items():
        count = sum(1 for kw in kws if kw in lower_html)
        if count > best_count:
            best_count = count
            niche = n

    # Score
    data = {
        "apps": apps,
        "pixels": pixels,
        "product_count": product_count,
        "theme": theme,
        "has_aliexpress": has_aliexpress,
        "top_products": products,
    }
    score, tier_name = _score_shop(data)
    score_tier_map = {
        "HOT": "\U0001f534 HOT",
        "RISING": "\U0001f7e0 RISING",
        "WATCH": "\U0001f7e1 WATCH",
        "COLD": "\u26aa COLD",
    }
    score_tier = score_tier_map[tier_name]

    # Estimate traffic (placeholder)
    traffic = [max(1, score // 10 + i * 2) for i in range(12)]

    # Strategy guess
    strategy = []
    if "Meta Pixel" in pixels:
        strategy.append("Meta Ads")
    if "TikTok Pixel" in pixels:
        strategy.append("TikTok Ads")
    if "Google Ads" in pixels or "Google Analytics" in pixels:
        strategy.append("Google Ads")
    if "Pinterest" in pixels:
        strategy.append("Pinterest Ads")
    if any(a in apps for a in ["Klaviyo", "Omnisend", "Mailchimp"]):
        strategy.append("Email Flows")
    if not strategy:
        strategy.append("Organic only")

    # Revenue estimate
    rev = score * 400
    if rev >= 1000:
        revenue_est = f"${rev // 1000}K/mo"
    else:
        revenue_est = f"${rev}/mo"
    ad_spend = rev // 5
    if ad_spend >= 1000:
        ad_spend_est = f"${ad_spend // 1000}K/mo"
    else:
        ad_spend_est = f"${ad_spend}/mo"

    return {
        "domain": domain,
        "shop_name": shop_name,
        "niche": niche,
        "score": score,
        "score_tier": score_tier,
        "is_pro": score >= 70,
        "freshness_label": _freshness_label(),
        "theme": theme,
        "currency": currency,
        "country": country,
        "pixels": pixels,
        "apps": apps,
        "product_count": product_count,
        "has_aliexpress": has_aliexpress,
        "traffic": traffic,
        "revenue_est": revenue_est,
        "ad_spend_est": ad_spend_est,
        "top_products": products,
        "strategy": strategy,
        "scanned_at": datetime.now(timezone.utc).isoformat(),
    }


async def _upsert_to_supabase(shop_data: dict):
    """Upsert a shop record into Supabase."""
    row = {
        "domain": shop_data["domain"],
        "shop_name": shop_data["shop_name"],
        "niche": shop_data["niche"],
        "score": shop_data["score"],
        "score_tier": shop_data["score_tier"],
        "is_pro": shop_data["is_pro"],
        "freshness_label": shop_data["freshness_label"],
        "theme": shop_data["theme"],
        "currency": shop_data["currency"],
        "country": shop_data["country"],
        "pixels": json.dumps(shop_data["pixels"]),
        "apps": json.dumps(shop_data["apps"]),
        "product_count": shop_data["product_count"],
        "has_aliexpress": shop_data["has_aliexpress"],
        "traffic": json.dumps(shop_data["traffic"]),
        "revenue_est": shop_data["revenue_est"],
        "ad_spend_est": shop_data["ad_spend_est"],
        "top_products": json.dumps(shop_data["top_products"]),
        "strategy": json.dumps(shop_data["strategy"]),
        "scanned_at": shop_data["scanned_at"],
    }

    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{SUPABASE_REST}/shops",
            headers=HEADERS,
            json=row,
        ) as resp:
            if resp.status not in (200, 201):
                body = await resp.text()
                raise HTTPException(
                    status_code=500,
                    detail=f"Supabase upsert failed: {resp.status} - {body}",
                )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/")
async def root():
    return {"status": "ok", "service": "SNIPING Scanner", "version": "1.0.0"}


@app.get("/health")
async def health():
    return {"status": "healthy"}


@app.post("/scan")
async def scan_single(req: ScanRequest):
    """Scan a single store, save to Supabase, return data."""
    _check_supabase()
    data = await scan_store(req.domain)
    await _upsert_to_supabase(data)
    return {"success": True, "shop": data}


@app.post("/scan/batch")
async def scan_batch(req: BatchScanRequest, background_tasks: BackgroundTasks):
    """Queue multiple stores for scanning in the background."""
    _check_supabase()
    async def _run():
        for domain in req.domains:
            try:
                data = await scan_store(domain)
                await _upsert_to_supabase(data)
            except Exception:
                pass  # skip failing stores
            await asyncio.sleep(1)  # rate-limit

    background_tasks.add_task(_run)
    return {
        "success": True,
        "message": f"Scanning {len(req.domains)} stores in background",
        "domains": req.domains,
    }


@app.get("/shops")
async def list_shops(niche: Optional[str] = None, min_score: int = 0):
    """Fetch shops from Supabase with optional filters."""
    _check_supabase()
    url = f"{SUPABASE_REST}/shops?select=*&order=score.desc"
    if niche and niche != "All":
        url += f"&niche=eq.{niche}"
    if min_score > 0:
        url += f"&score=gte.{min_score}"

    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=HEADERS) as resp:
            if resp.status != 200:
                raise HTTPException(status_code=500, detail="Failed to fetch shops")
            shops = await resp.json()

    # Parse JSON strings back to arrays
    for shop in shops:
        for field in ("pixels", "apps", "traffic", "top_products", "strategy"):
            if isinstance(shop.get(field), str):
                try:
                    shop[field] = json.loads(shop[field])
                except (json.JSONDecodeError, TypeError):
                    shop[field] = []

    return shops


@app.post("/scan/seed")
async def seed_demo(background_tasks: BackgroundTasks):
    """Seed the database with some well-known Shopify stores for demo."""
    _check_supabase()
    demo_domains = [
        "gymshark.com",
        "allbirds.com",
        "bombas.com",
        "chubbiesshorts.com",
        "ruggable.com",
        "pfrankmd.com",
        "mejuri.com",
        "rothys.com",
    ]

    async def _run():
        for domain in demo_domains:
            try:
                data = await scan_store(domain)
                await _upsert_to_supabase(data)
            except Exception:
                pass
            await asyncio.sleep(2)

    background_tasks.add_task(_run)
    return {"success": True, "message": f"Seeding {len(demo_domains)} stores"}
