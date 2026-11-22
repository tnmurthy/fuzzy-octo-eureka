# CampusGTM Signals & Ambassador Loop

This module connects **CampusGTM** to social channels and closed campus communities ("dark social") using an **Ambassador Inbound Loop** and indexes enriched signals into **Meilisearch** for sub-10ms search, campus geosearch, and faceted discovery.

---

## 1. Quick Start: Local Meilisearch

To start the local Meilisearch container:

```bash
cd campusgtm_signals
docker compose -f docker-compose.meilisearch.yml up -d
```

Check health:
```bash
curl http://localhost:7700/health
# {"status":"available"}
```

The master key is `MEILI_MASTER_KEY` in `campusgtm_signals/.env` (git-ignored;
generate with `openssl rand -hex 32`). Load it before the examples below:
`source campusgtm_signals/.env`. Production mode has no web dashboard.

---

## 2. Architecture & File Structure

| File | Purpose |
|---|---|
| `docker-compose.meilisearch.yml` | Self-hosted Meilisearch Docker service with persistent volume |
| `campus_registry.py` | Geolocation database and alias matcher for target engineering campuses |
| `schemas.py` | Standardized `CampusSignal`, `AmbassadorSubmission`, and `_geo` models |
| `ambassador_vision_extractor.py` | Gemini 2.5 Flash multimodal vision & OCR extractor with heuristic fallback |
| `meilisearch_client.py` | Async micro-batch indexer, ranking rules, typo-tolerance & geosearch |
| `ambassador_loop_service.py` | High-level coordinator linking ambassador submissions to search index |
| `discord_bot.py` | Discord Bot connector for campus servers, channel monitoring & slash commands |
| `test_campusgtm_signals.py` | Unit & integration test suite for ambassador loop |
| `test_discord_bot.py` | Test suite for Discord message filtering, intents & geocoding |

---

## 3. How the Ambassador Loop Works

1. **Submission**: A student ambassador forwards a campus flyer, event poster, or WhatsApp/Instagram story proof via WhatsApp or the CampusGTM web portal.
2. **Vision & OCR**: `ambassador_vision_extractor.py` calls Gemini 2.5 Flash to extract:
   - Event Title & Category (`hackathon`, `fest`, `workshop`, `ambassador_ugc`)
   - College / Campus name
   - Organizing Club (`ACM`, `IEEE`, `GDSC`, etc.)
   - Task Proof Validity (confirms story/status share)
3. **Geo-Resolution**: `campus_registry.py` maps the extracted college name to official coordinates (`_geo: { lat, lng }`).
4. **Meilisearch Micro-Batching**: Signals are queued and indexed in bulk into Meilisearch without locking the primary database.
5. **Instant Discovery**: Campus operators can search signals with typo-tolerance (`Gatech`, `CBIT`, `sympo`) and filter by radius (`_geoRadius(lat, lng, 10000)`).

---

## 4. Querying Signals in Meilisearch

### Instant Search with Typo-Tolerance:
```bash
curl -X POST 'http://localhost:7700/indexes/campus_signals/search' \
  -H "Authorization: Bearer $MEILI_MASTER_KEY" \
  -H 'Content-Type: application/json' \
  --data-raw '{
    "q": "hakathon",
    "filter": "category = \"hackathon\""
  }'
```

### Campus Geofencing Query (5km around CBIT Hyderabad):
```bash
curl -X POST 'http://localhost:7700/indexes/campus_signals/search' \
  -H "Authorization: Bearer $MEILI_MASTER_KEY" \
  -H 'Content-Type: application/json' \
  --data-raw '{
    "q": "fest",
    "filter": "_geoRadius(17.3917, 78.3197, 5000)"
  }'
```

---

## 5. Running the Discord Bot

The Discord bot connector monitors campus club and student community servers for announcements, hackathons, and ambassador submissions.

### Required Discord Bot Permissions (Developer Portal):
Enable **Privileged Gateway Intents**:
- `MESSAGE CONTENT INTENT`
- `SERVER MEMBERS INTENT`

### Interactive Slash Commands:
- `/search-campus query:<text>`: Searches Meilisearch directly from within Discord and embeds results.
- `/map-campus campus_id:<id>`: Links the current Discord server to a canonical campus in `campus_registry.py` (e.g. `cbit_hyderabad`).

### Run the Bot:
```bash
export DISCORD_BOT_TOKEN="your-bot-token"
python3 campusgtm_signals/discord_bot.py
```

---

## 6. Environment Variables

Create or set in your environment:
- `MEILI_HOST`: `http://127.0.0.1:7700`
- `MEILI_MASTER_KEY`: Master authentication key for Meilisearch
- `GEMINI_API_KEY`: Google Gemini API key for multimodal flyer OCR & vision analysis
- `DISCORD_BOT_TOKEN`: Discord Bot Token from Discord Developer Portal
