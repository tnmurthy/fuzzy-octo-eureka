"""
Meilisearch Client and Batch Indexer for CampusGTM.
Features:
- Auto-initialization of the `campus_signals` index
- Configuration of searchable, filterable, and _geo attributes
- Micro-batching queue to reduce write-lock contention
- Geosearch, typo-tolerant search, and faceted filtering
"""

import os
import sys
import json
import time
import urllib.request
import urllib.error
from typing import List, Dict, Any, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import env_loader

MEILI_HOST = os.environ.get("MEILI_HOST", "http://127.0.0.1:7700")
# No built-in key: set MEILI_MASTER_KEY (campusgtm_signals/.env). An empty key
# gets a clear 401 from Meilisearch instead of silently using a known one.
MEILI_MASTER_KEY = os.environ.get("MEILI_MASTER_KEY", "")
INDEX_NAME = "campus_signals"


class MeilisearchClient:
    def __init__(self, host: str = MEILI_HOST, master_key: str = MEILI_MASTER_KEY):
        self.host = host.rstrip("/")
        self.master_key = master_key
        self.batch_queue: List[Dict[str, Any]] = []
        self.last_flush_time = time.time()

    def _request(
        self,
        endpoint: str,
        method: str = "GET",
        data: Optional[Any] = None
    ) -> Dict[str, Any]:
        """Internal helper for Meilisearch REST API requests using standard library."""
        url = f"{self.host}{endpoint}"
        headers = {
            "Authorization": f"Bearer {self.master_key}",
            "Content-Type": "application/json"
        }
        
        req_data = json.dumps(data).encode("utf-8") if data is not None else None
        req = urllib.request.Request(url, data=req_data, headers=headers, method=method)
        
        with urllib.request.urlopen(req, timeout=10) as response:
            res_body = response.read().decode("utf-8")
            return json.loads(res_body) if res_body else {}

    def is_healthy(self) -> bool:
        """Checks if the local Meilisearch instance is accessible."""
        try:
            res = self._request("/health", method="GET")
            return res.get("status") == "available"
        except Exception:
            return False

    def init_index(self) -> Dict[str, Any]:
        """
        Creates the campus_signals index (if not existing) and configures
        searchable, filterable, and geospatial settings.
        """
        # 1. Create index if it does not exist
        try:
            self._request("/indexes", method="POST", data={
                "uid": INDEX_NAME,
                "primaryKey": "id"
            })
        except urllib.error.HTTPError as e:
            # 409 means index already exists, which is expected
            if e.code != 409:
                pass

        # 2. Configure index settings
        settings_payload = {
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
            ],
            "typoTolerance": {
                "enabled": True,
                "minWordSizeForTypos": {
                    "oneTypo": 4,
                    "twoTypos": 8
                }
            }
        }

        return self._request(f"/indexes/{INDEX_NAME}/settings", method="PATCH", data=settings_payload)

    def enqueue_document(self, document: Dict[str, Any], auto_flush_threshold: int = 50) -> Optional[Dict[str, Any]]:
        """
        Adds a document to the micro-batch queue. Flushes automatically when
        threshold is reached or 1 second has elapsed.
        """
        self.batch_queue.append(document)
        now = time.time()
        if len(self.batch_queue) >= auto_flush_threshold or (now - self.last_flush_time) >= 1.0:
            return self.flush()
        return None

    def flush(self) -> Optional[Dict[str, Any]]:
        """Flushes queued documents to Meilisearch in a single atomic batch."""
        if not self.batch_queue:
            return None

        docs_to_send = self.batch_queue[:]
        self.batch_queue.clear()
        self.last_flush_time = time.time()

        try:
            return self._request(f"/indexes/{INDEX_NAME}/documents", method="POST", data=docs_to_send)
        except Exception as e:
            # Re-queue on failure so documents are not lost
            self.batch_queue.extend(docs_to_send)
            raise e

    def search(
        self,
        query: str,
        campus_id: Optional[str] = None,
        category: Optional[str] = None,
        geo_radius: Optional[tuple] = None,  # (lat, lng, distance_in_meters)
        limit: int = 20,
        facets: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """
        Executes a search query against Meilisearch with optional filters and geosearch.
        """
        filters = []
        if campus_id:
            filters.append(f'campus_id = "{campus_id}"')
        if category:
            filters.append(f'category = "{category}"')
        if geo_radius:
            lat, lng, dist = geo_radius
            filters.append(f'_geoRadius({lat}, {lng}, {dist})')

        filter_expr = " AND ".join(filters) if filters else None

        search_payload: Dict[str, Any] = {
            "q": query,
            "limit": limit,
            "attributesToHighlight": ["title", "body"],
            "highlightPreTag": "<mark>",
            "highlightPostTag": "</mark>"
        }

        if filter_expr:
            search_payload["filter"] = filter_expr

        if facets:
            search_payload["facets"] = facets

        return self._request(f"/indexes/{INDEX_NAME}/search", method="POST", data=search_payload)
