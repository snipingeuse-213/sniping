# Plan Peekr — De 68K a 1 Million de Shops (v2 — Stress-tested)

## Audit du systeme actuel (31 mars 2026)

### Etat des lieux

| Metrique | Valeur |
|----------|--------|
| Shops en base | 68,452 |
| Taille base de donnees | 203 MB (50 MB data + 29 MB index + TOAST) |
| Limite plan Supabase Pro | 8 GB |
| Taches d'import completees | 1,799 |
| Taches en attente (bloquees) | 289 (0 shops importes) |
| Total upserts effectues | ~1,784,450 |
| Taux de doublons | ~96% (enorme gaspillage) |
| Cron job 1 | `auto_import_shops()` — toutes les heures |
| Cron job 2 | `import_shop_batch()` — toutes les minutes |

### Diagnostics des problemes

1. **Seulement 144 combos uniques** (12 pays x 6 mois x 2 groupes) → tourne en boucle
2. **Offset API cap a 1000** → max 1000 shops par combo
3. **Pas de filtre categorie** → ne profite pas de la profondeur de Store Leads
4. **Pas de variation du tri** → toujours les memes shops en haut
5. **96% de doublons** → 1.78M appels API pour seulement 68K uniques
6. **289 taches bloquees** → tasks avec 0 imports, probablement des combos vides

---

## Risques identifies et parades

### Risque 1 — Rate limit API inconnu
**Probleme** : Store Leads ne renvoie pas de headers `X-RateLimit`. On decouvre la limite seulement quand on recoit un `429 Too Many Requests`.
**Parade** : Demarrage LENT (1 tache/min), montee progressive. Detection automatique du 429 → pause globale pendant `Retry-After` secondes. Log de chaque 429 pour calibrer la vitesse optimale.

### Risque 2 — HTTP bloque les connexions PostgreSQL
**Probleme** : Chaque appel `http()` dans pg_cron bloque une connexion Supabase. A 50 appels/min, on risque de saturer les ~60 connexions du plan Pro.
**Parade** : Max 2 taches par run (au lieu de 5). Chaque tache = 5 pages (au lieu de 10). Total = 10 appels HTTP max par minute. Les connexions sont liberees entre chaque page.

### Risque 3 — Cron overlap (chevauchement)
**Probleme** : Si un run dure >1 min, le suivant demarre avant la fin.
**Parade** : `FOR UPDATE SKIP LOCKED` deja en place + ajout d'un guard : si le run precedent tourne encore, le nouveau se termine immediatement. Lock table `import_settings` pour le mutex.

### Risque 4 — Quota mensuel API
**Probleme** : Store Leads a peut-etre un quota mensuel. Si on le depasse, plus d'import pour le reste du mois.
**Parade** : Compteur d'appels API par jour dans `import_log`. Alerte si >5000 appels/jour. Possibilite de definir un plafond journalier configurable.

### Risque 5 — Tache bloquee sans recovery
**Probleme** : Si une tache plante (timeout, erreur reseau), elle reste en statut "in_progress" indefiniment.
**Parade** : Colonne `locked_at` + timeout de 5 min. Si une tache est locked depuis >5 min, elle est relachee automatiquement. Max 3 retries par tache (`retry_count`). Apres 3 echecs → statut "failed".

### Risque 6 — Taille de la base a 1M
**Probleme** : 68K = 203 MB. 1M pourrait atteindre ~3 GB.
**Parade** : Supabase Pro = 8 GB. Marge de 5 GB. Ajouter un check : si pg_total_relation_size > 6 GB, pause automatique des imports.

---

## Architecture v2 — "Slow and Steady"

### Principe : Aller LENTEMENT mais SUREMENT

Au lieu de viser 24h (risque), on vise **3-5 jours** avec zero risque de crash.

```
┌─────────────────────────────────────────────────────┐
│  generate_import_tasks()  —  CRON TOUTES LES 6H    │
│                                                     │
│  1. Genere des combos : pays x categorie x tri      │
│  2. Verifie qu'on n'a pas deja cette combo           │
│  3. Verifie qu'on n'a pas >800 shops pour ce combo   │
│  4. Insere dans import_tasks (statut = pending)      │
│  5. Genere max 200 taches par run                    │
└───────────────────┬─────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────┐
│  run_import_worker()  —  CRON TOUTES LES MINUTES    │
│                                                     │
│  1. Check kill_switch dans import_settings           │
│  2. Check si un run precedent est encore actif       │
│  3. Prend 2 taches pending (SKIP LOCKED)             │
│  4. Pour chaque tache : 5 pages x 50 records        │
│  5. Si status 429 → pause globale + log              │
│  6. Si erreur → retry_count++ (max 3)                │
│  7. Upsert dans shops (ON CONFLICT DO UPDATE)        │
│  8. Log : new_count, update_count, api_calls         │
│  9. Si offset >= 1000 → marque completed             │
└───────────────────┬─────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────┐
│  import_settings (table de config)                   │
│                                                     │
│  kill_switch : boolean (false = actif)               │
│  max_tasks_per_run : int (defaut 2)                  │
│  max_pages_per_task : int (defaut 5)                 │
│  max_api_calls_per_day : int (defaut 5000)           │
│  paused_until : timestamp (null = pas en pause)      │
│  total_api_calls_today : int                         │
└─────────────────────────────────────────────────────┘
```

### Table import_tasks

```sql
CREATE TABLE import_tasks (
  id SERIAL PRIMARY KEY,
  country TEXT NOT NULL,
  category TEXT,           -- ex: '/Apparel', '/Food & Drink'
  sort_type TEXT NOT NULL,  -- ex: 'rank', 'estimated_visits', 'estimated_sales'
  current_offset INT DEFAULT 0,
  status TEXT DEFAULT 'pending',  -- pending, in_progress, completed, failed
  locked_at TIMESTAMP,
  retry_count INT DEFAULT 0,
  new_count INT DEFAULT 0,
  update_count INT DEFAULT 0,
  api_calls INT DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  UNIQUE(country, category, sort_type)  -- evite les doublons de taches
);
```

### Table import_log (monitoring)

```sql
CREATE TABLE import_log (
  id SERIAL PRIMARY KEY,
  run_at TIMESTAMP DEFAULT NOW(),
  tasks_processed INT,
  new_shops INT,
  updated_shops INT,
  api_calls INT,
  errors INT,
  duration_ms INT
);
```

### Calcul realiste du potentiel

| Parametre | Valeur |
|-----------|--------|
| Pays | 40 |
| Categories Store Leads | ~50 (hierarchiques) |
| Tris | 6 |
| Combos uniques | 40 x 50 x 6 = **12 000** |
| Shops max par combo (offset 1000, 50/page) | 1 000 |
| Potentiel brut | 12M (mais beaucoup de chevauchement) |
| Potentiel unique estime | **2-4 millions** |
| Objectif | 1 million |

### Vitesse d'import (mode conservateur)

| Phase | Taches/min | Pages/tache | API calls/min | Nouvelles shops/h | Duree pour 1M |
|-------|-----------|------------|---------------|-------------------|---------------|
| Phase 1 (24h) | 1 | 5 | 5 | ~6 000 | test |
| Phase 2 (si OK) | 2 | 5 | 10 | ~12 000 | ~78h (~3j) |
| Phase 3 (si OK) | 3 | 5 | 15 | ~18 000 | ~52h (~2j) |

**Strategie** : On demarre en Phase 1 pendant 24h. Si zero 429 et la DB tient, on passe en Phase 2. Puis Phase 3.

---

## Implementation — Ordre des operations

### Etape 1 — Creer les tables (5 min)
- `import_tasks` (remplace import_progress)
- `import_log` (monitoring)
- `import_settings` (config + kill switch)

### Etape 2 — Creer generate_import_tasks() (10 min)
- Genere les combos pays x categorie x tri
- Skip les combos deja existantes
- Skip les combos ou on a deja >800 shops
- Max 200 nouvelles taches par run

### Etape 3 — Creer run_import_worker() (15 min)
- Remplace import_shop_batch()
- Avec toutes les parades : kill switch, 429 detection, retry, logging
- Garde le meme scoring et upsert (qui marche bien)

### Etape 4 — Desactiver les anciens crons (2 min)
- Desactiver auto_import_shops (job 1)
- Desactiver import_shop_batch (job 3)
- Nettoyer les 289 taches bloquees

### Etape 5 — Premier lancement (5 min)
- Lancer generate_import_tasks() manuellement
- Verifier que les taches sont bien creees
- Activer run_import_worker() en cron (1/min)

### Etape 6 — Monitoring pendant 24h
- Verifier les logs : new vs update ratio
- Verifier : pas de 429
- Verifier : taille DB stable
- Si OK → passer en Phase 2

### Etape 7 — Vue monitoring
```sql
SELECT
  date_trunc('hour', run_at) as hour,
  sum(new_shops) as new,
  sum(updated_shops) as updated,
  sum(api_calls) as calls,
  sum(errors) as errors
FROM import_log
GROUP BY 1 ORDER BY 1 DESC LIMIT 24;
```

---

## Taille estimee a 1M de shops

| Metrique | 68K shops | 1M shops (estime) |
|----------|-----------|-------------------|
| Data | 50 MB | ~735 MB |
| Index | 29 MB | ~425 MB |
| TOAST | ~124 MB | ~1.8 GB |
| Total | 203 MB | ~3 GB |
| Limite Supabase Pro | 8 GB | 8 GB |
| Marge restante | 7.8 GB | **5 GB** |

---

## Checklist de securite

- [ ] Kill switch teste (peut arreter les imports en 1 seconde)
- [ ] 429 detection testee (simule une reponse 429)
- [ ] Retry fonctionne (simule une erreur reseau)
- [ ] Pas de memory leak (monitorer pg_stat_activity)
- [ ] Dashboard reste rapide avec 1M shops (tester les queries)
- [ ] VACUUM automatique configure (evite le bloat)
- [ ] Backup automatique Supabase active
