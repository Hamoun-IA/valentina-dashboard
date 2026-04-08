# Valentina Dashboard — Audit complet

_Date : 2026-04-08 — Repo : `/root/valentina-dashboard` — Port : 8420 (systemd `valentina-dashboard.service`)_

---

## 1. Architecture actuelle

### Arborescence

```
valentina-dashboard/
├── backend/
│   ├── main.py              # Entry point FastAPI (71 l.)
│   ├── hermes_data.py       # Data layer SQLite → /api/* analytics (277 l.)
│   ├── voice_chat.py        # Router WebSocket voice + TTS ElevenLabs (387 l.)
│   ├── voice_usage.py       # Tracker SQLite voice_chat.db (95 l.)
│   ├── bridge_memory.py     # Memory unifiée (unified_turns + facts holographiques, 509 l.)
│   ├── lipsync.py           # Phonèmes → visèmes (timeline VRM, 228 l.)
│   └── requirements.txt
├── frontend/
│   ├── index.html           # Dashboard principal (166 l.)
│   ├── voice.html           # Voice chat UI (63 l.)
│   ├── avatar.html          # Avatar 3D VRM (176 l.)
│   ├── manifest.json / sw.js  # PWA
│   ├── css/
│   │   ├── style.css        # Cyberpunk glassmorphism (744 l.)
│   │   └── voice.css        # (549 l.)
│   ├── js/
│   │   ├── dashboard.js     # Charts + polling (339 l.)
│   │   ├── voice.js         # WS client voice (339 l.)
│   │   └── avatar.js        # three.js + VRM + lipsync (924 l.)
│   └── assets/models/       # fichiers VRM
├── venv/                    # Python 3.11
├── .env.systemd             # ⚠ pas de `export`, chargé par systemd
└── README.md
```

### Stack technique

| Couche | Tech |
|---|---|
| Backend | **FastAPI**, `httpx` (async), `sqlite3`, `pyyaml`, `pydantic` |
| Frontend | HTML + vanilla JS (pas de framework), **Chart.js 4.4.7** (CDN), three.js + @pixiv/three-vrm pour l'avatar |
| Données | SQLite : `~/.hermes/state.db` (hermes-agent), `~/.hermes/voice_chat.db` (Valentina) |
| Déploiement | systemd unit, exposé via Tailscale |
| PWA | manifest.json + service worker |
| Design | Cyberpunk glassmorphism (neon cyan/magenta/green/purple/orange), Orbitron + Rajdhani + JetBrains Mono |

### Entry points

- **Main** : `backend/main.py` → lancé par systemd (`uvicorn backend.main:app --host 0.0.0.0 --port 8420`)
- **Statics** : `/css`, `/js`, `/assets` montés depuis `frontend/`
- **Templates** : `FileResponse` directs (pas de moteur Jinja), 3 pages servies

---

## 2. Pages / routes FastAPI

### Pages (GET)
| Route | Sert | JS |
|---|---|---|
| `GET /` | `frontend/index.html` | `dashboard.js` |
| `GET /voice` | `frontend/voice.html` | `voice.js` |
| `GET /avatar` | `frontend/avatar.html` | `avatar.js` |
| `GET /manifest.json`, `GET /sw.js` | PWA | — |

### API REST (`main.py` + `voice_chat.py`)
| Méthode | Route | Fonction | Source data |
|---|---|---|---|
| GET | `/api/overview` | `hd.get_overview()` | `state.db` : sessions, messages, tokens, coût, today |
| GET | `/api/sessions?limit=N` | `hd.get_sessions()` | `state.db.sessions` (N dernières) |
| GET | `/api/providers` | `hd.get_providers_status()` | **STATIC** (dict `PROVIDERS` hardcodé, status toujours "active") |
| GET | `/api/tokens-by-provider` | `hd.get_token_usage_by_provider()` | `state.db` group by billing_provider |
| GET | `/api/activity?days=N` | `hd.get_activity_timeline()` | `state.db.messages` group by heure |
| GET | `/api/tools` | `hd.get_tool_usage()` | `state.db.messages` top 15 tool_name |
| GET | `/api/cron` | `hd.get_cron_jobs()` | `~/.hermes/cron/jobs.json` (⚠ fichier inexistant → renvoie `[]`) |
| GET | `/api/voice-stats` | `voice_usage.get_voice_stats()` | `voice_chat.db.voice_sessions` |
| POST | `/api/voice/tts` | ElevenLabs streaming | live |
| WS | `/ws/voice-chat` | Pipeline voice chat complet | Grok → fallback Gemini → ElevenLabs with-timestamps → visèmes |

---

## 3. Composants du dashboard principal (`index.html`)

Tous les composants font du **polling HTTP** (pas de WebSocket sur le dashboard). Auto-refresh global **30s** sur `overview`, `sessions`, `voice-stats` uniquement. Les charts sont dessinés une seule fois au load (pas de refresh).

| # | Composant | UI | Data | Source | Refresh |
|---|---|---|---|---|---|
| 1 | Stat card "Sessions totales" | big number + today | ✅ réel | `/api/overview` | 30s |
| 2 | Stat card "Messages" | big number + today | ✅ réel | `/api/overview` | 30s |
| 3 | Stat card "Tokens utilisés" | total + in/out | ✅ réel | `/api/overview` | 30s |
| 4 | Stat card "Tool Calls" | count + coût $ | ✅ réel | `/api/overview` | 30s |
| 5 | Stat card "Voice Chat" | total + breakdown | ✅ réel | `/api/voice-stats` | 30s |
| 6 | **Providers Arsenal** grid | 12 cartes icon/nom/tier/dot "active" | ⚠️ **placeholder** | `/api/providers` (dict hardcodé) | load only |
| 7 | Chart "Activité" (line) | messages/heure 7j | ✅ réel | `/api/activity?days=7` | load only |
| 8 | Chart "Modèles" (doughnut) | top 5 modèles | ✅ réel | `/api/overview.model_usage` | load only |
| 9 | Bars "Outils les plus utilisés" | top 10 tools | ✅ réel | `/api/tools` | load only |
| 10 | Chart "Tokens / provider" (bar stacked) | in/out par provider | ✅ réel | `/api/tokens-by-provider` | load only |
| 11 | Table "Sessions récentes" | 10 lignes | ✅ réel | `/api/sessions?limit=10` | 30s |

**Conclusion composants** : ~90 % des widgets sont branchés sur du réel (state.db), **sauf le bloc "Providers Arsenal"** qui est du décoratif pur (aucune ping API, aucun crédit, status toujours vert). C'est le principal gap.

---

## 4. Endpoints backend réutilisables

Tous sont JSON, synchrones, lecture seule sur SQLite local — très rapides et composables :

- `GET /api/overview` → dict de stats agrégées (sessions, messages, tokens, coût, today, top 5 modèles, sessions par source)
- `GET /api/sessions?limit=N` → liste détaillée (id, source, model, provider, tokens, coût, title, started/ended, end_reason)
- `GET /api/providers` → liste statique PROVIDERS (à enrichir — voir §5)
- `GET /api/tokens-by-provider` → breakdown in/out/tools/cost par billing_provider
- `GET /api/activity?days=N` → série temporelle messages/heure
- `GET /api/tools` → top 15 tools avec count
- `GET /api/cron` → lit `~/.hermes/cron/jobs.json` (inexistant → `[]`)
- `GET /api/voice-stats` → total/today/input_chars/output_chars/fallbacks + model_breakdown
- `POST /api/voice/tts` → streaming MP3

**Schéma SQLite `~/.hermes/state.db`** (disponible pour nouveaux endpoints) :
```
sessions(id, source, user_id, model, model_config, system_prompt, parent_session_id,
         started_at, ended_at, end_reason, message_count, tool_call_count,
         input_tokens, output_tokens, cache_read/write_tokens, reasoning_tokens,
         billing_provider, billing_base_url, billing_mode,
         estimated_cost_usd, actual_cost_usd, cost_status, cost_source,
         pricing_version, title)
messages (FTS5 activée via messages_fts)
```

**Schéma `~/.hermes/voice_chat.db`** :
```
voice_sessions(id, timestamp, user_text, assistant_text, model_used,
               input_chars, output_chars, tts_chars, fallback_used)
unified_turns(id, ts, channel, role, content, model)   -- voice + telegram
```

---

## 5. Intégrations providers

### État actuel côté dashboard

Le bloc "Providers Arsenal" affiche **12 providers hardcodés** (`PROVIDERS` dans `hermes_data.py`) avec icône/couleur/tier/status. **Aucun ping live, aucun crédit, aucune vérification de clé.**

Clés API disponibles dans `.env.systemd` :
`ZAI_API_KEY`, `MINIMAX_API_KEY`, `OPENROUTER_API_KEY`, `NOUS_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `GOOGLE_API_KEY`, `ELEVENLABS_API_KEY`, `RUNPOD_API_KEY`, `GITHUB_TOKEN`.
❌ Absents : `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `FAL_KEY`, `TAVILY_API_KEY` (à ajouter si on veut les monitorer).

### Tableau récap crédits / quotas

| Provider | Affiché dashboard | Crédits affichés | API crédits disponible ? | Endpoint |
|---|---|---|---|---|
| **Anthropic** | statique | ❌ | ⚠️ Pas d'endpoint public officiel pour solde. La Organization API (`/v1/organizations/usage_report/messages` et `/cost_report`) donne coût/tokens consommés (admin key `sk-ant-admin...`). Pour solde réel : scraper console ou suivre la conso calculée. | `GET https://api.anthropic.com/v1/organizations/usage_report/messages` |
| **OpenAI** (Codex/GPT) | statique | ❌ | Legacy billing endpoints dépréciés. Utiliser **Usage API** (nécessite admin key). | `GET https://api.openai.com/v1/organization/usage/completions` et `/costs` |
| **xAI Grok** | statique | ❌ | ✅ API dédiée | `GET https://api.x.ai/v1/api-key` → renvoie `{api_key_blocked, team_blocked, ...}` ; pour crédits : `GET https://api.x.ai/v1/usage` (à vérifier doc courante — xAI a ajouté récemment un endpoint de usage) |
| **Z.ai GLM** | statique | ❌ | ⚠️ Pas d'endpoint public documenté (plan-based). Fallback : ping `/v4/chat/completions` avec payload minimal pour health check. | `GET https://api.z.ai/api/paas/v4/models` (health) |
| **DeepSeek** | statique | ❌ | ✅ Endpoint dédié officiel | `GET https://api.deepseek.com/user/balance` → `{balance_infos: [{currency, total_balance, granted_balance, topped_up_balance}]}` |
| **MiniMax** | statique | ❌ | ✅ Endpoint billing | `GET https://api.minimax.chat/v1/query/account_balance` (header `Authorization: Bearer ...`) |
| **Google Gemini** | statique | ❌ | ❌ Pas d'API solde (facturation via GCP). Health : `GET https://generativelanguage.googleapis.com/v1beta/models?key=...` |
| **OpenRouter** | statique | ❌ | ✅ Endpoint officiel | `GET https://openrouter.ai/api/v1/auth/key` → `{data: {label, usage, limit, is_free_tier, rate_limit}}` et `GET /api/v1/credits` → `{data: {total_credits, total_usage}}` |
| **NousResearch** | statique | ❌ | ⚠️ API OpenAI-compat, pas d'endpoint solde connu. Health uniquement. | `GET https://inference-api.nousresearch.com/v1/models` |
| **FAL.ai** | statique | ❌ | ⚠️ Pas d'endpoint public documenté côté REST. Console uniquement. | — |
| **ElevenLabs** | statique | ❌ | ✅ Endpoint dédié | `GET https://api.elevenlabs.io/v1/user/subscription` → `{character_count, character_limit, next_character_count_reset_unix, tier, status, ...}` |
| **RunPod** | statique | ❌ | ✅ GraphQL | `POST https://api.runpod.io/graphql` query `{ myself { clientBalance } }` (header `Authorization: Bearer RUNPOD_API_KEY`) |
| **Tavily** | ❌ pas intégré | ❌ | ✅ Endpoint dédié | `POST https://api.tavily.com/usage` body `{api_key: "..."}` → crédits restants |

**Note** : pour tous ceux qui ne fournissent pas de solde explicite (Anthropic, OpenAI, Gemini, FAL, Nous, Z.ai), la stratégie pragmatique est de **calculer la conso en local** via `state.db.estimated_cost_usd` par billing_provider et de définir un "budget" manuel dans un fichier de config `~/.hermes/budgets.json` pour afficher un pourcentage restant.

---

## 6. Système de logs / conversations

Deux SQLite distinctes :

### a) `~/.hermes/state.db` (hermes-agent, source de vérité principale)
- Tables : `sessions`, `messages`, `messages_fts` (full-text search FTS5), `schema_version`
- Contient **toutes** les sessions CLI + Telegram (pas voice) avec contenu complet des messages
- Déjà exploité par le dashboard pour stats mais **pas pour afficher le contenu des messages**
- **Pas d'endpoint actuel pour lire les messages d'une session** → easy win

### b) `~/.hermes/voice_chat.db` (owned par Valentina)
- `voice_sessions` : historique voice complet (user_text + assistant_text + model + fallback)
- `unified_turns` : log temps réel (voice + telegram) utilisé pour la mémoire court-terme
- **Pas d'endpoint actuel pour lire** → easy win

### c) Fichiers JSONL
- `~/.hermes/sessions/*.jsonl` et `*.json` : dumps de requêtes/sessions hermes-agent (richer data : full messages, tool calls)
- `~/.hermes/logs/agent.log`, `errors.log`, `gateway.log` : logs techniques

### d) Mémoire long-terme
- `~/.hermes/memory_store.db` : holographic fact store (HRR / vectoriel), exploité par `bridge_memory.py`
- `~/.hermes/memories/USER.md`, `MEMORY.md` : faits persona
- `~/.hermes/SOUL.md` : personality prompt

**→ Gap évident : aucun endpoint n'expose le contenu des messages ni les faits holographiques. Tout est prêt à être servi.**

---

## 7. Tracking des tâches

État actuel : **très incomplet**.

- `GET /api/cron` lit `~/.hermes/cron/jobs.json` qui **n'existe pas** (vérifié : `~/.hermes/cron/` ne contient que `.tick.lock` et un dossier `output/` vide). Renvoie donc toujours `[]`.
- `~/.hermes/processes.json` existe mais contient `[]` (aucun tracking de processus actif).
- `~/.hermes/gateway.pid` existe → le gateway hermes tourne, mais aucune intégration dashboard.
- `~/.hermes/checkpoints/`, `~/.hermes/hindsight/`, `~/.hermes/sandboxes/` : dossiers hermes-agent mais non exposés.
- Pas de notion de "delegated subagent", pas de queue, pas de WebSocket push pour l'état live.

**→ Il n'y a littéralement aucun suivi temps réel des tâches dans le dashboard aujourd'hui.** C'est 100 % à construire.

---

## 8. Gaps & opportunités (priorisées ROI)

### 🔥 Must-have (cockpit)

1. **Endpoint `/api/providers/credits`** : aggregator async qui ping en parallèle les providers avec API solde (DeepSeek, OpenRouter, ElevenLabs, MiniMax, RunPod, Tavily, xAI) + calcule la conso locale pour les autres. Cache 5 min. Rebrancher `Providers Arsenal` sur cette data → remplacer le dot "active" bidon par un **anneau de progression** (% crédits restants) + tooltip avec balance exacte + code couleur (vert/orange/rouge).

2. **Endpoint `/api/messages?session_id=...`** et **viewer de conversations** : nouvelle page `/logs` avec liste sessions + panneau détails (messages + tool calls). Utilise `messages_fts` pour full-text search cyberpunk. Haut ROI car toute la data existe.

3. **WebSocket `/ws/live`** : stream d'events temps réel (nouveau message, nouvelle session, provider down, coût franchi). Le dashboard écoute et incrémente les counters sans polling. Fallback polling pour pages froides.

4. **Widget "Tâches en cours"** :
   - Endpoint `/api/tasks/active` qui lit `~/.hermes/processes.json` + scan des sessions `state.db` où `ended_at IS NULL`
   - Endpoint `/api/tasks/cron` qui scanne `crontab -l` + `~/.hermes/cron/output/*`
   - Widget "Subagents délégués" : à construire — nécessite d'instrumenter hermes-agent pour écrire dans une nouvelle table `delegations(id, parent_session, child_session, started_at, status, summary)`
   - Bouton "kill task" (contrôle actif) → exécuter `kill PID` côté backend

5. **Budget / cost burndown** : nouvelle card avec gauge circulaire "budget mensuel restant" (config dans `~/.hermes/budgets.json`). Alertes webhook Telegram si >80 %.

### 💎 Nice-to-have (premium)

6. **Charts qui se rafraîchissent** : actuellement les charts sont dessinés une fois. Ajouter `chart.update()` dans l'interval 30s.
7. **Filtres / date range picker** sur activité et sessions (déjà supporté côté backend via `?days=`, manque l'UI).
8. **Search bar FTS** (cmd+K) sur les messages (`messages_fts` est déjà là).
9. **Provider health history** : sparkline des ping success/fail par provider (nouvelle table `provider_pings`).
10. **Page `/memory`** : explorateur du fact store holographique (requête sémantique → top facts avec score).
11. **Action panel "Control"** : reload config.yaml, restart gateway, switch default model, toggle personality, clear cache, lancer un cron ad-hoc.
12. **Dark telemetry** : CPU/RAM/GPU hôte (via `psutil`) — utile pour RunPod et lipsync.
13. **Exposer `messages` avec contenu dans le cadre d'une page "timeline"** avec regroupement par jour et highlight tool calls.
14. **Notifications browser** via service worker (déjà enregistré) pour events critiques.

### 🧹 Dette technique

15. `voice_chat.py` ligne 28 : `XAI_API_KEY=os.env...EY", "")` — **code corrompu** (sed malheureux). Même ligne 35 pour ElevenLabs et ligne 42 pour `FIRST_TOKEN_TIMEOUT=***`. **À corriger d'urgence** (probablement la redaction s'est appliquée au code source, pas juste à l'output du grep). À vérifier si le service tourne vraiment.
16. `/api/cron` pointe sur un fichier inexistant, donne une fausse impression de feature.
17. Pas de router séparé pour les endpoints analytics (tout dans `main.py`). Créer `backend/routers/analytics.py`, `providers.py`, `logs.py`, `tasks.py`.
18. Aucun test.
19. Aucune auth — dashboard exposé uniquement via Tailscale, donc OK pour l'instant, mais si un jour on ouvre en public, prévoir un simple bearer token.

---

## 9. Stack technique recommandée pour les nouveaux composants

**Principe directeur : ne rien casser, rester cohérent avec l'existant.**

### Backend
- **FastAPI** + routers séparés dans `backend/routers/` : `analytics.py`, `providers.py`, `logs.py`, `tasks.py`, `control.py`
- **httpx.AsyncClient** pour tous les pings providers (déjà utilisé dans `voice_chat.py`), avec `asyncio.gather` pour le parallélisme
- **TTL cache in-memory** simple (`functools.lru_cache` + timestamp, ou `cachetools.TTLCache`) pour les crédits providers (5 min)
- **WebSocket** `/ws/live` : broadcast minimaliste avec un set de clients + `asyncio.Queue` par client. Pas besoin de Redis pour un seul process.
- **SQLite** reste la seule DB. Pour les nouvelles tables (delegations, provider_pings, budgets), créer un fichier `~/.hermes/dashboard.db` séparé pour ne pas polluer `state.db`. Migrations simples (`CREATE TABLE IF NOT EXISTS`).
- **pydantic** models pour toutes les réponses (types stricts pour le JS) + génération automatique de la doc OpenAPI déjà offerte par FastAPI (`/docs`).

### Frontend
- **Vanilla JS**, pas de framework (cohérence + perf PWA). Si besoin de réactivité : petite lib maison type `observable` (≤ 50 lignes) ou [Alpine.js] en CDN si vraiment nécessaire.
- **Chart.js 4** pour tous les charts (déjà chargé). Pour les jauges circulaires de crédits : plugin `chartjs-gauge` ou doughnut avec `rotation: -90, circumference: 180`.
- **Conventions CSS** : réutiliser les variables existantes `--neon-cyan`, `--neon-magenta`, `--neon-green`, `--neon-purple`, `--neon-orange`, `--neon-pink`, `--neon-yellow`, la classe `.glass`, `.card`, `.animate-in delay-N`.
- **Polices** : Orbitron (titres), Rajdhani (UI), JetBrains Mono (code / data).
- **Icônes** : emojis (comme l'existant) ou heroicons inline SVG si besoin de plus sérieux.
- **Structure d'un nouveau widget** :
  ```html
  <section class="card glass animate-in">
    <div class="card-header">
      <div class="card-title"><span class="icon">💰</span>TITRE</div>
    </div>
    <div class="..."></div>
  </section>
  ```
- **WebSocket client** : pattern simple avec reconnexion exponentielle (repiquer le style de `voice.js`).

### Pages à créer
| Route | Contenu |
|---|---|
| `/logs` | Liste sessions + reader de messages + search FTS |
| `/tasks` | Active tasks + cron + subagents + kill buttons |
| `/providers` | Deep dive par provider : crédits, historique ping, modèles, coût cumulé |
| `/memory` | Explorateur fact store holographique |
| `/control` | Action panel (restart gateway, switch model, personality...) |

### Nouveaux endpoints à créer (priorité)
```
GET  /api/providers/credits            → dict {provider: {balance, limit, usage, status, last_check}}
GET  /api/providers/{pid}/history      → sparkline ping success/fail
GET  /api/sessions/{id}/messages       → contenu complet des messages d'une session
GET  /api/messages/search?q=...        → FTS5 sur messages
GET  /api/tasks/active                 → processus + sessions en cours
GET  /api/tasks/cron                   → crontab + outputs récents
GET  /api/tasks/subagents              → delegations table
POST /api/tasks/{id}/kill              → kill PID
GET  /api/budget                       → config + conso + % restant
POST /api/budget                       → maj budgets
GET  /api/memory/facts?q=...           → fact store holographique
POST /api/control/reload-config        → recharge config.yaml
POST /api/control/restart-gateway      → systemctl restart hermes-gateway
WS   /ws/live                          → events temps réel
```

---

## TL;DR pour délégation

> Le dashboard a des **fondations propres** (FastAPI simple + Chart.js + glassmorphism + 2 SQLite pleines de data) et **~90 % de ses composants sont déjà branchés au réel**. Le gros trou noir c'est la section "Providers" qui est 100 % décoratif, et l'absence totale de viewer de messages et de tracking de tâches. Les 5 prochains chantiers, dans l'ordre :
>
> 1. **Fix `backend/voice_chat.py`** (lignes 28/35/42 corrompues par une redaction — service peut être cassé).
> 2. **`/api/providers/credits`** aggregator + refactor du widget Providers Arsenal.
> 3. **Viewer de conversations** (`/logs` + endpoints messages + FTS search).
> 4. **WebSocket `/ws/live`** + refacto du polling en push.
> 5. **Tasks/Subagents tracker** (nouvelle table `dashboard.db`, widget + kill).
>
> Stack : rester FastAPI + vanilla JS + Chart.js + SQLite. Nouveaux routers dans `backend/routers/`. Nouvelle DB `~/.hermes/dashboard.db` pour ne pas polluer `state.db`. Réutiliser les classes `.glass .card .animate-in` et les variables `--neon-*` pour la cohérence visuelle.
