"""
SNIPING ENGINE — Module 3 : ScoringEngine
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Calcule un score de potentiel (0-100) pour chaque boutique détectée.

Logique de scoring :
  - Pixels de tracking        → 30 pts max  (signe d'investissement pub)
  - Apps installées           → 20 pts max  (pro setup)
  - Produits disponibles      → 15 pts max  (catalogue établi)
  - Freshness                 → 20 pts max  (plus c'est frais, mieux c'est)
  - Indicateurs PRO           → 15 pts max  (thème premium, currency, etc.)
"""

from datetime import datetime, timezone
from typing import Optional
import math

class ScoringEngine:

    # ─── Poids des critères ───────────────────────────────────────────────────

    WEIGHTS = {
        "pixels":    30,   # Pixels Meta/TikTok/Google
        "apps":      20,   # Nombre d'apps installées
        "products":  15,   # Catalogue produits
        "freshness": 20,   # Ancienneté de détection
        "pro_signals": 15, # Signaux pro divers
    }

    HIGH_VALUE_PIXELS = {"Meta Pixel", "TikTok Pixel", "Google Ads", "Snapchat"}

    def score(self, shop_data: dict) -> dict:
        """
        Calcule le score et retourne le shop enrichi.
        """
        breakdown = {
            "pixels":      self._score_pixels(shop_data),
            "apps":        self._score_apps(shop_data),
            "products":    self._score_products(shop_data),
            "freshness":   self._score_freshness(shop_data),
            "pro_signals": self._score_pro_signals(shop_data),
        }

        total = sum(breakdown.values())
        total = min(100, max(0, round(total)))  # Clamp 0-100

        # Niveau de menace
        if total >= 80:   tier = "🔴 HOT"
        elif total >= 60: tier = "🟠 RISING"
        elif total >= 40: tier = "🟡 WATCH"
        else:             tier = "⚪ COLD"

        return {
            **shop_data,
            "score":          total,
            "score_tier":     tier,
            "score_breakdown": breakdown,
            "freshness_label": self._freshness_label(shop_data),
            "meta_ad_library_url": self._meta_ad_library_url(shop_data["domain"]),
        }

    # ─── Scorers individuels ──────────────────────────────────────────────────

    def _score_pixels(self, shop: dict) -> float:
        """
        Pixels = investissement pub réel.
        Meta + TikTok en même temps → max score.
        """
        pixels = set(shop.get("pixels", []))
        high_value = len(pixels & self.HIGH_VALUE_PIXELS)

        if high_value == 0:   return 0
        if high_value == 1:   return self.WEIGHTS["pixels"] * 0.5
        if high_value == 2:   return self.WEIGHTS["pixels"] * 0.85
        return self.WEIGHTS["pixels"]  # 3+

    def _score_apps(self, shop: dict) -> float:
        """
        Plus d'apps = setup plus professionnel.
        Courbe logarithmique : la différence entre 1 et 5 apps est grande,
        entre 10 et 15 beaucoup moins.
        """
        count = len(shop.get("apps", []))
        if count == 0: return 0
        # log base 20 normalisé
        score = math.log(count + 1) / math.log(21) * self.WEIGHTS["apps"]
        return min(score, self.WEIGHTS["apps"])

    def _score_products(self, shop: dict) -> float:
        """
        Un catalogue de produits = store établi.
        """
        count = shop.get("product_count", 0)
        if count == 0:   return 0
        if count < 5:    return self.WEIGHTS["products"] * 0.3
        if count < 20:   return self.WEIGHTS["products"] * 0.6
        if count < 50:   return self.WEIGHTS["products"] * 0.85
        return self.WEIGHTS["products"]

    def _score_freshness(self, shop: dict) -> float:
        """
        Plus le store est récent, plus le score freshness est élevé.
        L'avantage SNIPING : agir avant les autres.
        - < 6h  → 100% du poids
        - < 12h → 85%
        - < 24h → 65%
        - < 72h → 40%
        - > 72h → 10%
        """
        detected_at_str = shop.get("detected_at", "")
        if not detected_at_str:
            return self.WEIGHTS["freshness"] * 0.1

        try:
            detected_at = datetime.fromisoformat(detected_at_str)
            now = datetime.utcnow()
            age_hours = (now - detected_at).total_seconds() / 3600

            if age_hours < 6:    factor = 1.0
            elif age_hours < 12: factor = 0.85
            elif age_hours < 24: factor = 0.65
            elif age_hours < 72: factor = 0.40
            else:                factor = 0.10

            return self.WEIGHTS["freshness"] * factor
        except:
            return self.WEIGHTS["freshness"] * 0.1

    def _score_pro_signals(self, shop: dict) -> float:
        """
        Signaux divers de professionnalisme.
        """
        signals = 0
        max_signals = 6

        theme = shop.get("theme", "Unknown").lower()
        premium_themes = ["prestige", "empire", "impulse", "turbo", "shoptimized",
                          "booster", "motion", "refresh", "dawn"]
        if any(t in theme for t in premium_themes):
            signals += 1

        # Devise non-USD = marché ciblé
        if shop.get("currency") and shop["currency"] != "USD":
            signals += 1

        # Domaine custom (pas myshopify.com)
        if not shop.get("domain", "").endswith(".myshopify.com"):
            signals += 2  # Domaine custom = investissement sérieux

        # App de reviews = social proof installé
        review_apps = {"Loox", "Judge.me", "Yotpo", "Stamped.io"}
        if set(shop.get("apps", [])) & review_apps:
            signals += 1

        # Description meta renseignée
        if shop.get("description"):
            signals += 1

        return (signals / max_signals) * self.WEIGHTS["pro_signals"]

    # ─── Helpers ──────────────────────────────────────────────────────────────

    def _freshness_label(self, shop: dict) -> str:
        """Retourne un label lisible pour la fraîcheur."""
        detected_at_str = shop.get("detected_at", "")
        if not detected_at_str:
            return "Unknown"
        try:
            detected_at = datetime.fromisoformat(detected_at_str)
            age_hours = (datetime.utcnow() - detected_at).total_seconds() / 3600
            if age_hours < 1:    return f"{int(age_hours * 60)}min ago"
            if age_hours < 24:   return f"{int(age_hours)}h ago"
            return f"{int(age_hours / 24)}d ago"
        except:
            return "Unknown"

    def _meta_ad_library_url(self, domain: str) -> str:
        """Génère le lien direct vers la Meta Ad Library pour ce domaine."""
        # Cherche via le nom de domaine principal
        clean = domain.replace(".myshopify.com", "").replace("www.", "")
        return f"https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&q={clean}&search_type=keyword_unordered"
