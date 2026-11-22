# Meilisearch Reference Guide for CampusGTM

This document records the official references, architectural patterns, and API specifications borrowed from the upstream repository [meilisearch/meilisearch](https://github.com/meilisearch/meilisearch.git) for the **CampusGTM** signal ingestion and discovery engine.

---

## 1. Upstream Repository & Documentation Links

* **Source Repository:** [github.com/meilisearch/meilisearch](https://github.com/meilisearch/meilisearch)
* **Official Documentation:** [https://www.meilisearch.com/docs](https://www.meilisearch.com/docs)
* **Live Public Endpoint:** `https://search.mytestbed.tech` (via Cloudflare Tunnel)
* **Read-Only Search API Key:** Vercel env `MEILI_SEARCH_KEY` (from `GET /keys` with the master key; never written here)
* **Local Host Endpoint:** `http://127.0.0.1:7700`
* **Docker Image:** `getmeili/meilisearch:v1.12` ([Docker Hub](https://hub.docker.com/r/getmeili/meilisearch))

### Official SDKs
* **Python SDK:** [github.com/meilisearch/meilisearch-python](https://github.com/meilisearch/meilisearch-python) (`pip install meilisearch`)
* **JavaScript / TypeScript SDK:** [github.com/meilisearch/meilisearch-js](https://github.com/meilisearch/meilisearch-js) (`npm install meilisearch`)
* **Frontend React InstantSearch:** [github.com/meilisearch/instant-meilisearch](https://github.com/meilisearch/instant-meilisearch)

---

## 2. Core Architectural Concepts Borrowed

### A. Typo-Tolerance via Damerau-Levenshtein Prefix Automaton
* **Documentation:** [Typo Tolerance Settings](https://www.meilisearch.com/docs/learn/configuration/typo_tolerance)
* **Application in CampusGTM:** Students use slang, shorthand, and acronyms (`Gatech`, `CBIT`, `acm-w`, `sympo`, `hackathn`). Meilisearch matches queries within 1–2 typos and supports prefix matching as users type.

### B. Campus Geosearch (`_geo` and `_geoRadius`)
* **Documentation:** [Geosearch Guide](https://www.meilisearch.com/docs/learn/filtering_and_sorting/geosearch)
* **Reserved Field:** Any document containing a `_geo` object with `{ "lat": float, "lng": float }` is automatically indexed in Meilisearch’s spatial index.
* **Campus Filter Expression:**
  ```text
  _geoRadius(lat, lng, distance_in_meters)
  ```
  Example (5km radius around CBIT Hyderabad):
  ```text
  _geoRadius(17.3917, 78.3197, 5000)
  ```

### C. Asynchronous Document Batching (`/tasks`)
* **Documentation:** [Asynchronous Tasks API](https://www.meilisearch.com/docs/reference/api/tasks)
* **Application in CampusGTM:** When hundreds of ambassador proofs or social posts stream in per minute, writing individual rows creates lock contention. CampusGTM borrows Meilisearch's micro-batching pattern (`meilisearch_client.py`) by queuing items and executing bulk updates in batches of 50.

### D. Sequential Ranking Rules (Deterministic Relevance)
* **Documentation:** [Ranking Rules Guide](https://www.meilisearch.com/docs/learn/core_concepts/relevancy#ranking-rules)
* **Configured Order:**
  1. `words`: Documents containing more query words rank first.
  2. `typo`: Documents with fewer typos rank higher.
  3. `proximity`: Documents where query terms are close together rank higher.
  4. `attribute`: Matches in `title` outrank matches in `body`.
  5. `sort`: Sort rules (e.g. `posted_at:desc`).
  6. `exactness`: Exact matches outrank partial prefix matches.

### E. Faceted Filtering & Distribution
* **Documentation:** [Filter Search Results](https://www.meilisearch.com/docs/learn/filtering_and_sorting/filter_search_results)
* **Application in CampusGTM:** Calculates real-time facet counts (`platform`, `campus_id`, `category`, `verification_status`) in sub-10ms without running expensive SQL aggregate queries.

---

## 3. REST API Specification

### A. Health Check
```http
GET /health HTTP/1.1
Host: localhost:7700
```
**Response:**
```json
{
  "status": "available"
}
```

---

### B. Index Configuration (`PATCH /indexes/campus_signals/settings`)
```http
PATCH /indexes/campus_signals/settings HTTP/1.1
Host: localhost:7700
Authorization: Bearer <MEILI_MASTER_KEY>
Content-Type: application/json

{
  "searchableAttributes": [
    "title",
    "body",
    "campus_name",
    "category",
    "author_handle",
    "extracted_entities.clubs",
    "extracted_entities.fests"
  ],
  "filterableAttributes": [
    "platform",
    "campus_id",
    "category",
    "sentiment",
    "is_ambassador",
    "_geo",
    "posted_at",
    "verification_status"
  ],
  "sortableAttributes": [
    "posted_at"
  ],
  "rankingRules": [
    "words",
    "typo",
    "proximity",
    "attribute",
    "sort",
    "exactness"
  ]
}
```

---

### C. Ingest Documents Micro-Batch (`POST /indexes/campus_signals/documents`)
```http
POST /indexes/campus_signals/documents HTTP/1.1
Host: localhost:7700
Authorization: Bearer <MEILI_MASTER_KEY>
Content-Type: application/json

[
  {
    "id": "whatsapp_a1b2c3d4e5f67890",
    "platform": "whatsapp",
    "campus_id": "cbit_hyderabad",
    "campus_name": "Chaitanya Bharathi Institute of Technology",
    "title": "CBIT Hackathon 2026",
    "body": "Hackathon registration flyer shared on class group.",
    "author_handle": "Rahul Sharma",
    "media_urls": ["https://assets.mytestbed.tech/flyers/cbit_hack.jpg"],
    "posted_at": 1732000000,
    "is_ambassador": true,
    "ambassador_id": "amb_007",
    "category": "hackathon",
    "sentiment": "positive",
    "verification_status": "verified",
    "confidence_score": 0.95,
    "_geo": {
      "lat": 17.3917,
      "lng": 78.3197
    }
  }
]
```
**Response:**
```json
{
  "taskUid": 42,
  "indexUid": "campus_signals",
  "status": "enqueued",
  "type": "documentAdditionOrUpdate"
}
```

---

### D. Execute Instant Geosearch Query (`POST /indexes/campus_signals/search`)
```http
POST /indexes/campus_signals/search HTTP/1.1
Host: localhost:7700
Authorization: Bearer <MEILI_MASTER_KEY>
Content-Type: application/json

{
  "q": "hackathon",
  "filter": "campus_id = \"cbit_hyderabad\" AND _geoRadius(17.3917, 78.3197, 5000)",
  "limit": 10,
  "facets": ["category", "platform", "verification_status"],
  "attributesToHighlight": ["title", "body"]
}
```
**Response:**
```json
{
  "hits": [
    {
      "id": "whatsapp_a1b2c3d4e5f67890",
      "platform": "whatsapp",
      "campus_id": "cbit_hyderabad",
      "title": "CBIT Hackathon 2026",
      "_formatted": {
        "title": "CBIT <mark>Hackathon</mark> 2026"
      },
      "_geo": {
        "lat": 17.3917,
        "lng": 78.3197
      }
    }
  ],
  "facetDistribution": {
    "category": { "hackathon": 1 },
    "platform": { "whatsapp": 1 },
    "verification_status": { "verified": 1 }
  },
  "processingTimeMs": 2
}
```
