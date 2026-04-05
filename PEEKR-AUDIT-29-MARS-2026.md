# PEEKR — Audit Mise sur le Marché
**Date : 29 mars 2026**

---

## Situation Actuelle

### Base de données
| Métrique | Valeur | Objectif |
|----------|--------|----------|
| Total shops | **63 189** | 1M+ (comme TrendTrack) |
| Shops "hot" (score ≥75) | 1 460 | — |
| Shops "rising" (score 55-74) | 6 255 | — |
| Pays couverts | 154 | — |
| Shops avec données pub | **7** | Tous |
| Import tasks en cours | 2 072 | — |
| Import tasks terminées | 16 | — |
| Vitesse actuelle | ~100 nouveaux/heure | 3 000+/heure |
| Cron jobs actifs | 2 | — |
| Dernier import | 29/03 à 15h48 | Continu |

**Problème :** L'import tourne mais la majorité des shops sont déjà en base (ON CONFLICT = update, pas insert). Il faut diversifier les filtres pour aller chercher de nouveaux shops.

---

### Pages & Features

| Page | URL | Statut | Bloquant ? |
|------|-----|--------|------------|
| Landing | `/` | ✅ Live, design premium | Non |
| Dashboard (Trending Shops) | `/peekr-dashboard.html` | ✅ Fonctionne, 1998 shops affichés | Oui — liens non cliquables |
| Login | `/login.html` | ✅ Auth Supabase OK | Non |
| Signup | `/signup.html` | ✅ Auth Supabase OK | Non |
| Pricing | `/peekr-pricing.html` | ✅ 4 plans affichés | Oui — pas de paiement |
| Trending Ads | `/peekr-trending-ads.html` | ❌ Vide — aucune donnée pub | Oui |
| Brand Tracker | `/peekr-brand-tracker.html` | ❌ Placeholder, non interactif | Non (Pro feature) |
| Best Trends | `/peekr-best-trends.html` | ⚠️ Fonctionnel mais contenu limité | Non |
| Duel Mode | `/peekr-duel.html` | ⚠️ UI présente, à vérifier | Non (Pro feature) |
| Blog & Tips | `/peekr-blog.html` | ⚠️ Page existe, contenu à créer | Non |
| Saved Shops/Ads | `/peekr-saved.html` | ⚠️ Fonctionne côté UI | Non |
| Export | `/peekr-export.html` | ⚠️ UI présente | Non (Pro feature) |
| Affiliate | `/peekr-affiliate.html` | ✅ Page complète | Non |
| Terms | `/peekr-terms.html` | ✅ Page complète | Non |
| Overview | `/peekr-overview.html` | ⚠️ Dashboard alternatif | Non |

---

## Les 5 Blockers au Lancement

### 1. 💳 Pas de paiement (Stripe)
**Impact : CRITIQUE — impossible de générer du cash**

Aucune intégration Stripe. Les boutons "Upgrade" renvoient vers la page pricing mais il n'y a aucun checkout. Le freemium gating est codé côté frontend (blurs, locks) mais c'est purement visuel sans backend de paiement.

**À faire :**
- Créer un compte Stripe (ou activer celui en attente)
- Intégrer Stripe Checkout pour les 3 plans payants ($29, $79, $199)
- Connecter au champ `subscriptions` dans Supabase
- Webhook Stripe → Supabase pour activer/désactiver les plans

### 2. 🔗 Liens shops non cliquables
**Impact : ÉLEVÉ — le produit ne sert à rien si on ne peut pas visiter les shops**

Les domaines affichés dans le dashboard (timex.com, dooney.com, etc.) ne sont pas des liens cliquables. L'utilisateur voit un nom de domaine mais ne peut pas cliquer dessus.

**À faire :** Wrapper chaque domaine dans un `<a href="https://domain" target="_blank">` dans le dashboard HTML.

### 3. 📊 Aucune donnée pub Meta (7 shops sur 63K)
**Impact : ÉLEVÉ — c'est la promesse core de Peekr ("The ads crushing it")**

La table `ads` est quasi vide. Trending Ads est vide. Pas de pipeline d'import Meta Ads.

**À faire :**
- Définir une source de données pub (Meta Ad Library API, scraping, ou fournisseur tiers)
- Créer un pipeline d'import pour alimenter la table `ads`
- Connecter Trending Ads au vrai contenu

### 4. 🐌 Import trop lent (100 shops/h au lieu de 3000+)
**Impact : MOYEN — 63K shops c'est utilisable mais loin des 1M+ des concurrents**

L'import tourne mais la plupart des domains sont déjà en base. Seuls 16 tasks sur 2088 sont terminées. La fonction ne traite que 2 tasks/minute avec 5 pages chacune.

**À faire :**
- Augmenter `max_tasks` de 2 à 5
- Augmenter `total_pages` de 5 à 10
- Diversifier les filtres (catégories, dates de création, sorts différents)
- Reset les tasks complétées avec de nouveaux offsets/filtres

### 5. 🏷️ Domaine & branding
**Impact : MOYEN — crédibilité pour les premiers utilisateurs**

Le site est sur `sniping-three.vercel.app`. Pas de domaine custom. Le repo s'appelle encore "sniping".

**À faire :**
- Acheter `peekr.io` (ou alternative)
- Configurer le domaine custom sur Vercel
- Renommer le repo GitHub → `peekr`

---

## Plan d'Action Prioritaire

### Phase 1 — MVP Payant (1-2 jours)
**Objectif : premier euro**

1. **Stripe Checkout** — intégrer les 3 plans payants
2. **Liens cliquables** — fix rapide dans le HTML (30 min)
3. **Domaine custom** — acheter et configurer peekr.io

### Phase 2 — Données (3-5 jours)
**Objectif : rendre le produit utile**

4. **Booster l'import** — passer à 3K+ shops/heure
5. **Pipeline Meta Ads** — source de données + import automatique
6. **Trending Ads** — connecter à la vraie data

### Phase 3 — Contenu & Engagement (1 semaine)
**Objectif : rétention et SEO**

7. **Blog & Tips** — 10 articles ecom (carte blanche)
8. **Brand Tracker** — rendre interactif pour les plans Pro+
9. **Best Trends** — enrichir avec les vrais trends par niche

---

## Ce qui marche bien

- ✅ Design premium (landing, dashboard) — niveau Notion/Stripe
- ✅ Auth Supabase fonctionnelle (login/signup)
- ✅ Freemium gating codé (blurs, locks, limites par plan)
- ✅ Scoring des shops (0-100 avec trend tags)
- ✅ 63K shops avec données riches (traffic, revenue, apps, categories)
- ✅ 154 pays couverts
- ✅ Import automatique pg_cron en place
- ✅ Filtres et recherche dans le dashboard
- ✅ Sidebar navigation complète
- ✅ Responsive CSS
- ✅ Vercel webhook reconnecté

---

## Verdict

Peekr est à **70% du MVP**. Le design et l'UX sont au niveau. La data de shops est solide. Ce qui manque pour lancer : Stripe (cash), liens cliquables (usage), et données pub Meta (promesse produit). Avec 2-3 jours de focus intense, c'est lançable.
