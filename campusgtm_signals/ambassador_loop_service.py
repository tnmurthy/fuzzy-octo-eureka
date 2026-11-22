"""
Ambassador Loop Service for CampusGTM.
Coordinates ambassador submissions, automated verification, and indexing.
"""

import os
import sys
from typing import Dict, Any, List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from schemas import AmbassadorSubmission, TaskVerificationResult, CampusSignal
from ambassador_vision_extractor import process_ambassador_submission
from meilisearch_client import MeilisearchClient


class AmbassadorLoopService:
    def __init__(self, meili_client: Optional[MeilisearchClient] = None):
        self.meili_client = meili_client or MeilisearchClient()
        self.verified_records: List[Dict[str, Any]] = []

    def handle_inbound_submission(
        self,
        submission: AmbassadorSubmission,
        auto_index: bool = True
    ) -> Dict[str, Any]:
        """
        Receives an ambassador's inbound flyer/proof submission:
        1. Processes OCR and task verification.
        2. Normalizes to CampusSignal with campus geocoding.
        3. Enqueues the document into Meilisearch for instant search.
        4. Returns the verification verdict and indexed signal.
        """
        verification, signal = process_ambassador_submission(submission)

        record = {
            "submission_id": submission.submission_id,
            "ambassador_id": submission.ambassador_id,
            "ambassador_name": submission.ambassador_name,
            "verification": verification.to_dict(),
            "signal": signal.to_meili_doc()
        }

        self.verified_records.append(record)

        # Enqueue to Meilisearch if enabled
        if auto_index:
            try:
                self.meili_client.enqueue_document(signal.to_meili_doc())
            except Exception:
                # If Meilisearch is temporarily unreachable, record is still preserved in memory/DB
                pass

        return record

    def search_campus_signals(
        self,
        query: str,
        campus_id: Optional[str] = None,
        category: Optional[str] = None,
        geo_radius: Optional[tuple] = None
    ) -> Dict[str, Any]:
        """Queries the Meilisearch cluster for signals."""
        return self.meili_client.search(
            query=query,
            campus_id=campus_id,
            category=category,
            geo_radius=geo_radius
        )
