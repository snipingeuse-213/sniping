"""
SNIPING ENGINE v1.0 — Backend Principal
FastAPI + WebSocket pour les feeds temps réel
"""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import asyncio
import json

from modules.cert_scanner import CertScanner
from modules.shop_parser import ShopParser
from modules.scoring_engine import ScoringEngine
from models.shop import Shop

# ─── Store en mémoire (remplacer par Redis en prod) ─────────────────────────
detected_shops: list[dict] = []
active_connections: list[WebSocket] = []

# ─── Lifecycle ───────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lance le scanner en arrière-plan au démarrage."""
    scanner_task = asyncio.create_task(background_scanner())
    yield
    scanner_task.cancel()

app = FastAPI(
    title="SNIPING ENGINE API",
    version="1.0.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Scanner continu ─────────────────────────────────────────────────────────
async def background_scanner():
    """Tâche de fond : scan crt.sh toutes les 5 minutes."""
    scanner = CertScanner()
    parser = ShopParser()
    scorer = ScoringEngine()

    while True:
        try:
            print("[SCANNER] Démarrage d'un cycle de scan...")
            new_domains = await scanner.fetch_new_shopify_domains()

            for domain in new_domains:
                shop_data = await parser.analyze_shop(domain)
                if shop_data:
                    scored = scorer.score(shop_data)
                    detected_shops.append(scored)
                    # Broadcast WebSocket à tous les clients connectés
                    await broadcast(scored)

            print(f"[SCANNER] Cycle terminé — {len(new_domains)} domaines traités")
        except Exception as e:
            print(f"[SCANNER ERROR] {e}")

        await asyncio.sleep(300)  # Pause 5 minutes

async def broadcast(shop: dict):
    """Envoie une boutique à tous les clients WebSocket connectés."""
    for ws in active_connections:
        try:
            await ws.send_json(shop)
        except:
            active_connections.remove(ws)

# ─── Routes REST ─────────────────────────────────────────────────────────────
@app.get("/api/shops")
async def get_shops(
    freshness: str = None,   # "12h", "24h", "72h"
    pro_only: bool = False,
    niche: str = None,
    limit: int = 50
):
    """Retourne les boutiques détectées avec filtres optionnels."""
    shops = detected_shops.copy()

    if pro_only:
        shops = [s for s in shops if s.get("is_pro")]
    if niche:
        shops = [s for s in shops if niche.lower() in s.get("niche", "").lower()]
    if freshness:
        hours = {"12h": 12, "24h": 24, "72h": 72}.get(freshness, 72)
        from datetime import datetime, timedelta
        cutoff = datetime.utcnow() - timedelta(hours=hours)
        shops = [s for s in shops if s.get("detected_at", "") >= cutoff.isoformat()]

    return {"shops": shops[:limit], "total": len(detected_shops)}

@app.get("/api/shops/{domain}/duel")
async def get_shop_detail(domain: str):
    """Retourne les données complètes d'une boutique pour le Duel Mode."""
    shop = next((s for s in detected_shops if s["domain"] == domain), None)
    if not shop:
        parser = ShopParser()
        scorer = ScoringEngine()
        data = await parser.analyze_shop(domain)
        if data:
            shop = scorer.score(data)
    return shop or {"error": "Shop not found"}

# ─── WebSocket Feed ──────────────────────────────────────────────────────────
@app.websocket("/ws/feed")
async def websocket_feed(websocket: WebSocket):
    """WebSocket pour le Sniper Feed temps réel."""
    await websocket.accept()
    active_connections.append(websocket)
    # Envoie les 20 dernières boutiques au moment de la connexion
    for shop in detected_shops[-20:]:
        await websocket.send_json(shop)
    try:
        while True:
            await websocket.receive_text()  # Keep-alive
    except WebSocketDisconnect:
        active_connections.remove(websocket)
