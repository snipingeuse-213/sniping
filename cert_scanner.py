"""
SNIPING ENGINE — Module 1 : CertScanner
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Surveille les flux de certificats SSL via crt.sh pour détecter
les nouveaux domaines Shopify en temps quasi-réel.

Sources :
  - crt.sh (Certificate Transparency Logs)
  - Plages IP Shopify (23.227.38.0/24, 2620:0127::/32)
"""

import asyncio
import aiohttp
import json
import re
from datetime import datetime, timedelta
from typing import Optional
import logging

logger = logging.getLogger(__name__)

# ─── Constantes ──────────────────────────────────────────────────────────────

CRT_SH_URL = "https://crt.sh/?q={query}&output=json"

# Shopify héberge ses stores sur ces plages IP
SHOPIFY_IP_RANGES = [
    "23.227.38.0/24",      # Principale IPv4
    "2620:0127::/32",      # IPv6
]

# Patterns pour détecter un domaine Shopify
SHOPIFY_PATTERNS = [
    r".*\.myshopify\.com$",                    # Stores natifs
    r".*shopify.*",                             # Variantes
]

# Indice de confiance minimum pour qu'un domaine soit traité
MIN_CERT_CONFIDENCE = 0.6

# ─── CertScanner ─────────────────────────────────────────────────────────────

class CertScanner:
    """
    Monitore crt.sh pour détecter les nouveaux domaines Shopify.
    Utilise les Certificate Transparency Logs (CTL) qui enregistrent
    chaque nouveau certificat SSL émis — quasi temps réel (délai ~1-5min).
    """

    def __init__(self, lookback_hours: int = 1):
        self.lookback_hours = lookback_hours
        self._seen_domains: set[str] = set()
        self._session: Optional[aiohttp.ClientSession] = None

    async def _get_session(self) -> aiohttp.ClientSession:
        if not self._session or self._session.closed:
            timeout = aiohttp.ClientTimeout(total=30)
            self._session = aiohttp.ClientSession(
                timeout=timeout,
                headers={"User-Agent": "SNIPING-ENGINE/1.0 research-tool"}
            )
        return self._session

    async def fetch_new_shopify_domains(self) -> list[str]:
        """
        Pipeline principal :
        1. Requête crt.sh pour *.myshopify.com
        2. Requête crt.sh pour domaines custom Shopify (via SAN)
        3. Filtre les domaines déjà vus + domaines trop anciens
        4. Retourne la liste propre de nouveaux domaines
        """
        tasks = [
            self._query_crtsh("%.myshopify.com"),
            self._query_crtsh("%.shop"),           # Domaines .shop souvent Shopify
            self._query_crtsh("%.store"),          # Idem .store
        ]

        results = await asyncio.gather(*tasks, return_exceptions=True)

        all_domains: list[str] = []
        for result in results:
            if isinstance(result, Exception):
                logger.warning(f"Erreur crt.sh : {result}")
                continue
            all_domains.extend(result)

        # Déduplique + filtre les déjà vus
        new_domains = []
        for domain in set(all_domains):
            if domain not in self._seen_domains:
                self._seen_domains.add(domain)
                new_domains.append(domain)

        logger.info(f"[CertScanner] {len(new_domains)} nouveaux domaines détectés")
        return new_domains

    async def _query_crtsh(self, query: str) -> list[str]:
        """
        Requête l'API JSON de crt.sh.
        Retourne les domaines émis dans la fenêtre lookback_hours.

        Structure de réponse crt.sh :
        [
          {
            "id": 12345,
            "logged_at": "2024-01-15T10:30:00",
            "not_before": "2024-01-15T00:00:00",
            "not_after": "2025-01-15T00:00:00",
            "common_name": "mystore.myshopify.com",
            "name_value": "mystore.myshopify.com",
            "issuer_name": "Let's Encrypt Authority X3",
            "issuer_ca_id": 16418
          },
          ...
        ]
        """
        url = CRT_SH_URL.format(query=query)
        session = await self._get_session()
        cutoff = datetime.utcnow() - timedelta(hours=self.lookback_hours)

        try:
            async with session.get(url) as response:
                if response.status != 200:
                    logger.warning(f"crt.sh HTTP {response.status} pour {query}")
                    return []

                text = await response.text()
                data = json.loads(text)

        except (aiohttp.ClientError, json.JSONDecodeError) as e:
            logger.error(f"Erreur fetch crt.sh [{query}] : {e}")
            return []

        domains = []
        for entry in data:
            # Filtre sur la fraîcheur du certificat
            logged_at_str = entry.get("logged_at", "")
            if logged_at_str:
                try:
                    logged_at = datetime.fromisoformat(logged_at_str.replace("Z", ""))
                    if logged_at < cutoff:
                        continue  # Trop vieux
                except ValueError:
                    pass

            # Extraction des domaines depuis common_name et name_value
            for field in ["common_name", "name_value"]:
                raw = entry.get(field, "")
                # name_value peut contenir plusieurs domaines séparés par \n
                for domain in raw.split("\n"):
                    domain = domain.strip().lower().lstrip("*.")
                    if self._is_valid_shopify_domain(domain):
                        domains.append(domain)

        return list(set(domains))

    def _is_valid_shopify_domain(self, domain: str) -> bool:
        """
        Vérifie qu'un domaine est potentiellement un store Shopify.
        Logique :
        - Domaine myshopify.com → 100% Shopify
        - Domaine .shop / .store → probable, sera vérifié côté ShopParser
        - Exclut les wildcards, IPs, et domaines Shopify internes
        """
        if not domain or len(domain) < 4:
            return False
        if "*" in domain:
            return False
        if re.match(r"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$", domain):
            return False  # IP brute

        # Domaines internes Shopify à exclure
        excluded = [
            "shopify.com", "myshopify.com", "shopifycloud.com",
            "shopifysvc.com", "shopifycdn.com", "cdn.shopify.com",
        ]
        if any(domain == ex or domain.endswith(f".{ex}") for ex in excluded):
            # Exception : *.myshopify.com EST valide (les stores)
            if domain.endswith(".myshopify.com") and domain != "myshopify.com":
                return True
            return False

        return True

    async def verify_shopify_store(self, domain: str) -> bool:
        """
        Vérifie qu'un domaine custom est bien un store Shopify
        en cherchant l'en-tête X-ShopId ou en vérifiant /products.json.
        """
        session = await self._get_session()
        urls_to_check = [
            f"https://{domain}/products.json?limit=1",
            f"https://{domain}",
        ]

        for url in urls_to_check:
            try:
                async with session.head(url, allow_redirects=True) as resp:
                    headers = resp.headers
                    # Shopify injecte toujours ces headers
                    if any(h in headers for h in ["X-ShopId", "X-Shopify-Stage", "X-Sorting-Hat-ShopId"]):
                        return True
                    # Certains stores ont powered-by-shopify
                    server = headers.get("x-powered-by", "").lower()
                    if "shopify" in server:
                        return True
            except:
                continue

        return False

    async def close(self):
        if self._session and not self._session.closed:
            await self._session.close()


# ─── Test standalone ──────────────────────────────────────────────────────────
if __name__ == "__main__":
    async def test():
        scanner = CertScanner(lookback_hours=2)
        print("🎯 SNIPING — Test CertScanner")
        print("Scanning crt.sh pour nouveaux domaines Shopify...")

        domains = await scanner.fetch_new_shopify_domains()
        print(f"\n✅ {len(domains)} domaines détectés :")
        for d in domains[:20]:
            print(f"  → {d}")

        if domains:
            print(f"\nVérification Shopify pour : {domains[0]}")
            is_shopify = await scanner.verify_shopify_store(domains[0])
            print(f"  Est un store Shopify : {is_shopify}")

        await scanner.close()

    asyncio.run(test())
