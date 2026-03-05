"""
SNIPING ENGINE — Module 2 : ShopParser
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Analyse une boutique Shopify détectée et extrait :
  - Thème utilisé
  - Apps installées (via code source)
  - Pixels de tracking (Meta, TikTok, GA4)
  - Produits bestsellers
  - Niche / catégorie
  - Stack technique
"""

import asyncio
import aiohttp
import re
import json
from bs4 import BeautifulSoup
from datetime import datetime
from typing import Optional
import logging

logger = logging.getLogger(__name__)

# ─── Signatures d'Apps Shopify ────────────────────────────────────────────────
# Détectées via le code source HTML / scripts

APP_SIGNATURES = {
    # Avis & Social Proof
    "Loox":              r"loox\.io",
    "Judge.me":          r"judge\.me",
    "Stamped.io":        r"stamped\.io",
    "Yotpo":             r"yotpo\.com",
    # Email Marketing
    "Klaviyo":           r"klaviyo\.com|a\.klaviyo\.com",
    "Omnisend":          r"omnisend\.com",
    "Mailchimp":         r"mailchimp\.com",
    # Upsell / Conversion
    "ReConvert":         r"reconvert\.com",
    "CartHook":          r"carthook\.com",
    "Zipify":            r"zipify\.com",
    "Bold Upsell":       r"boldapps\.net",
    "Frequently Bought": r"frequently-bought",
    # Chat / Support
    "Tidio":             r"tidio\.com",
    "Gorgias":           r"gorgias\.com",
    "Zendesk":           r"zopim\.com|zendesk\.com",
    # Countdown / Urgency
    "Hurify":            r"hurrify\.com",
    "Countdown Timer":   r"countdowntimer",
    "FOMO":              r"fomo\.com",
    # Loyalty
    "Smile.io":          r"smile\.io",
    "LoyaltyLion":       r"loyaltylion\.com",
    # Shipping
    "Trackr":            r"trackr\.com",
    "AfterShip":         r"aftership\.com",
    # Analytics
    "Lucky Orange":      r"luckyorange\.com",
    "Hotjar":            r"hotjar\.com",
    # Dropshipping
    "DSers":             r"dsers\.com",
    "Zendrop":           r"zendrop\.com",
    "AutoDS":            r"autods\.com",
    # Page Builder
    "GemPages":          r"gempages\.net",
    "PageFly":           r"pagefly\.io",
    "Shogun":            r"getshogun\.com",
}

PIXEL_SIGNATURES = {
    "Meta Pixel":    r"connect\.facebook\.net|fbq\(",
    "TikTok Pixel":  r"analytics\.tiktok\.com|ttq\.",
    "Google Ads":    r"googleadservices\.com|gtag\(",
    "GA4":           r"google-analytics\.com/g/collect|gtag\('config'",
    "Pinterest":     r"ct\.pinterest\.com|pintrk\(",
    "Snapchat":      r"tr\.snapchat\.com",
}

THEME_PATTERNS = {
    r"Shopify\.theme\.name\s*=\s*['\"](.+?)['\"]": "js_var",
    r'"theme_name":\s*"(.+?)"':                    "json_key",
    r'theme-name.*?content="(.+?)"':               "meta_tag",
    r'Shopify\.theme\s*=\s*\{.*?"name":\s*"(.+?)"': "theme_obj",
}

# ─── ShopParser ──────────────────────────────────────────────────────────────

class ShopParser:
    """Analyse complète d'une boutique Shopify."""

    def __init__(self):
        timeout = aiohttp.ClientTimeout(total=15)
        self._session = aiohttp.ClientSession(
            timeout=timeout,
            headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                              "AppleWebKit/537.36 (KHTML, like Gecko) "
                              "Chrome/120.0.0.0 Safari/537.36"
            }
        )

    async def analyze_shop(self, domain: str) -> Optional[dict]:
        """
        Analyse complète d'un store Shopify.
        Retourne None si le store est inaccessible ou non-Shopify.
        """
        base_url = f"https://{domain}"

        # Lancement parallèle de toutes les analyses
        tasks = await asyncio.gather(
            self._fetch_homepage(base_url),
            self._fetch_products(base_url),
            self._fetch_sitemap(base_url),
            return_exceptions=True
        )

        html_data, products_data, sitemap_data = tasks

        # Si la homepage est inaccessible → skip
        if isinstance(html_data, Exception) or not html_data:
            logger.debug(f"[Parser] {domain} inaccessible")
            return None

        html, soup = html_data
        products = products_data if not isinstance(products_data, Exception) else []
        # sitemap_data for future use

        # Extraction de toutes les données
        shop_data = {
            "domain":       domain,
            "detected_at":  datetime.utcnow().isoformat(),
            "base_url":     base_url,

            # Analyse HTML
            "theme":        self._detect_theme(html),
            "apps":         self._detect_apps(html),
            "pixels":       self._detect_pixels(html),
            "shop_name":    self._extract_shop_name(soup),
            "description":  self._extract_meta_description(soup),
            "favicon":      self._extract_favicon(soup, base_url),
            "currency":     self._extract_currency(html),
            "language":     self._extract_language(soup),

            # Analyse Produits
            "products":         products[:10],  # 10 premiers
            "product_count":    len(products),
            "niche":            self._guess_niche(products, soup),
            "has_aliexpress":   self._check_aliexpress_images(products),

            # Flags Pro
            "is_pro":       False,  # Calculé après
        }

        # Flag PRO : Pixel Meta/TikTok + 5+ apps
        has_tracking_pixel = any(
            p in shop_data["pixels"]
            for p in ["Meta Pixel", "TikTok Pixel"]
        )
        shop_data["is_pro"] = has_tracking_pixel and len(shop_data["apps"]) >= 5

        return shop_data

    # ─── Fetchers ────────────────────────────────────────────────────────────

    async def _fetch_homepage(self, base_url: str) -> Optional[tuple[str, BeautifulSoup]]:
        try:
            async with self._session.get(base_url) as resp:
                if resp.status != 200:
                    return None
                html = await resp.text()
                soup = BeautifulSoup(html, "html.parser")
                return html, soup
        except Exception as e:
            raise e

    async def _fetch_products(self, base_url: str) -> list[dict]:
        """Récupère /products.json — endpoint public de tous les stores Shopify."""
        url = f"{base_url}/products.json?limit=50&sort_by=created-descending"
        try:
            async with self._session.get(url) as resp:
                if resp.status != 200:
                    return []
                data = await resp.json()
                products = data.get("products", [])
                return [self._parse_product(p) for p in products]
        except:
            return []

    async def _fetch_sitemap(self, base_url: str) -> list[str]:
        """Récupère les URLs depuis sitemap.xml."""
        try:
            async with self._session.get(f"{base_url}/sitemap.xml") as resp:
                if resp.status != 200:
                    return []
                text = await resp.text()
                urls = re.findall(r"<loc>(.*?)</loc>", text)
                return urls
        except:
            return []

    # ─── Parseurs ────────────────────────────────────────────────────────────

    def _detect_theme(self, html: str) -> str:
        """Détecte le thème Shopify via plusieurs patterns."""
        for pattern, _ in THEME_PATTERNS.items():
            match = re.search(pattern, html, re.IGNORECASE | re.DOTALL)
            if match:
                return match.group(1).strip()
        # Fallback : recherche dans les classes CSS du body
        soup = BeautifulSoup(html, "html.parser")
        body = soup.find("body")
        if body:
            classes = " ".join(body.get("class", []))
            if "dawn" in classes.lower():    return "Dawn"
            if "debut" in classes.lower():   return "Debut"
            if "impulse" in classes.lower(): return "Impulse"
            if "empire" in classes.lower():  return "Empire"
        return "Unknown"

    def _detect_apps(self, html: str) -> list[str]:
        """Détecte les apps installées via leurs signatures dans le HTML."""
        found = []
        for app_name, pattern in APP_SIGNATURES.items():
            if re.search(pattern, html, re.IGNORECASE):
                found.append(app_name)
        return found

    def _detect_pixels(self, html: str) -> list[str]:
        """Détecte les pixels de tracking."""
        found = []
        for pixel_name, pattern in PIXEL_SIGNATURES.items():
            if re.search(pattern, html, re.IGNORECASE):
                found.append(pixel_name)
        return found

    def _extract_shop_name(self, soup: BeautifulSoup) -> str:
        og_site = soup.find("meta", property="og:site_name")
        if og_site:
            return og_site.get("content", "")
        title = soup.find("title")
        return title.text.strip() if title else ""

    def _extract_meta_description(self, soup: BeautifulSoup) -> str:
        meta = soup.find("meta", attrs={"name": "description"})
        return meta.get("content", "") if meta else ""

    def _extract_favicon(self, soup: BeautifulSoup, base_url: str) -> str:
        icon = soup.find("link", rel=lambda x: x and "icon" in x)
        if icon and icon.get("href"):
            href = icon["href"]
            if href.startswith("http"):
                return href
            return f"{base_url}{href}"
        return f"{base_url}/favicon.ico"

    def _extract_currency(self, html: str) -> str:
        match = re.search(r'"currency":\s*"([A-Z]{3})"', html)
        return match.group(1) if match else "USD"

    def _extract_language(self, soup: BeautifulSoup) -> str:
        html_tag = soup.find("html")
        return html_tag.get("lang", "en")[:2] if html_tag else "en"

    def _parse_product(self, p: dict) -> dict:
        """Simplifie un produit Shopify."""
        variants = p.get("variants", [{}])
        first_variant = variants[0] if variants else {}
        images = p.get("images", [])
        return {
            "id":          p.get("id"),
            "title":       p.get("title", ""),
            "handle":      p.get("handle", ""),
            "vendor":      p.get("vendor", ""),
            "price":       first_variant.get("price", "0"),
            "image":       images[0].get("src", "") if images else "",
            "tags":        p.get("tags", []),
            "created_at":  p.get("created_at", ""),
            "product_type": p.get("product_type", ""),
        }

    def _guess_niche(self, products: list[dict], soup: BeautifulSoup) -> str:
        """Devine la niche à partir des tags produits et du contenu."""
        NICHES = {
            "beauty":       ["beauty", "skincare", "makeup", "cosmetic", "serum", "lip", "face"],
            "fashion":      ["clothing", "dress", "shirt", "fashion", "apparel", "wear", "outfit"],
            "fitness":      ["gym", "workout", "fitness", "sport", "exercise", "training", "yoga"],
            "pets":         ["dog", "cat", "pet", "animal", "puppy", "kitten"],
            "home":         ["home", "decor", "kitchen", "furniture", "living", "bedroom"],
            "tech":         ["phone", "gadget", "tech", "electronic", "cable", "wireless"],
            "jewelry":      ["ring", "necklace", "bracelet", "jewelry", "earring", "gold"],
            "dropshipping": ["aliexpress", "dsers", "oberlo", "dropship"],
        }

        # Collecte tous les textes disponibles
        text_corpus = " ".join([
            p.get("title", "") + " " + " ".join(p.get("tags", []))
            for p in products
        ]).lower()

        scores = {}
        for niche, keywords in NICHES.items():
            score = sum(text_corpus.count(kw) for kw in keywords)
            if score > 0:
                scores[niche] = score

        return max(scores, key=scores.get) if scores else "general"

    def _check_aliexpress_images(self, products: list[dict]) -> bool:
        """Vérifie si les images produits proviennent d'AliExpress/fournisseurs."""
        aliexpress_patterns = [
            "aliexpress", "alicdn", "ae01.alicdn", "ae02.alicdn",
            "dsers", "cjdropshipping"
        ]
        for product in products:
            image_url = product.get("image", "").lower()
            if any(p in image_url for p in aliexpress_patterns):
                return True
        return False

    async def close(self):
        await self._session.close()
