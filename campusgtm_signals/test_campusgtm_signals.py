"""
Unit and Integration Tests for CampusGTM Signals & Ambassador Loop.
Run via: python3 campusgtm_signals/test_campusgtm_signals.py
"""

import os
import sys
import unittest

# Ensure the package directory is in sys.path for direct script execution
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from campus_registry import find_campus_by_text, get_campus_by_id, list_all_campuses
from schemas import (
    CampusSignal,
    AmbassadorSubmission,
    GeoPoint
)
from ambassador_vision_extractor import (
    heuristic_extract,
    process_ambassador_submission
)
from meilisearch_client import MeilisearchClient
from ambassador_loop_service import AmbassadorLoopService


class TestCampusRegistry(unittest.TestCase):
    def test_campus_lookup_by_alias(self):
        cbit = find_campus_by_text("Hey everyone, CBIT hackathon registrations are live!")
        self.assertIsNotNone(cbit)
        self.assertEqual(cbit["id"], "cbit_hyderabad")
        self.assertAlmostEqual(cbit["lat"], 17.3917, places=3)
        self.assertAlmostEqual(cbit["lng"], 78.3197, places=3)

    def test_iit_hyderabad_match(self):
        iith = find_campus_by_text("Annual techno-cultural fest Elan & nVision at IIT-H Kandi campus")
        self.assertIsNotNone(iith)
        self.assertEqual(iith["id"], "iit_hyderabad")

    def test_unknown_campus(self):
        unknown = find_campus_by_text("Random generic announcement with no college name")
        self.assertIsNone(unknown)

    def test_get_by_id(self):
        campus = get_campus_by_id("vnr_vjiet")
        self.assertIsNotNone(campus)
        self.assertIn("vjiet", campus["aliases"])


class TestSchemas(unittest.TestCase):
    def test_campus_signal_meili_serialization(self):
        geo = GeoPoint(lat=17.5947, lng=78.1230)
        signal = CampusSignal(
            platform="whatsapp",
            external_id="msg_987654",
            campus_id="iit_hyderabad",
            campus_name="IIT Hyderabad",
            title="GenAI Hackathon 2026",
            body="Registrations now open for students across Telangana",
            author_handle="rahul_ambassador",
            geo=geo,
            category="hackathon"
        )

        doc = signal.to_meili_doc()
        self.assertTrue(doc["id"].startswith("whatsapp_"))
        self.assertEqual(doc["campus_id"], "iit_hyderabad")
        self.assertEqual(doc["category"], "hackathon")
        self.assertIn("_geo", doc)
        self.assertEqual(doc["_geo"]["lat"], 17.5947)
        self.assertEqual(doc["_geo"]["lng"], 78.1230)


class TestAmbassadorVisionExtractor(unittest.TestCase):
    def test_heuristic_hackathon_extraction(self):
        caption = "CBIT Hackathon 2026: Build the future with AI and Web3!\nOrganized by ACM student chapter."
        extracted = heuristic_extract(caption)

        self.assertEqual(extracted["category"], "hackathon")
        self.assertIn("ACM", extracted["clubs_mentioned"])
        self.assertTrue(extracted["is_proof_valid"])

    def test_process_submission_with_campus_resolution(self):
        submission = AmbassadorSubmission(
            submission_id="sub_001",
            ambassador_id="amb_123",
            ambassador_name="Sneha Reddy",
            caption_text="Shared the official poster for VNR VJIET Convergence Fest on our WhatsApp class group!"
        )

        verification, signal = process_ambassador_submission(submission)

        self.assertTrue(verification.is_valid)
        self.assertEqual(verification.detected_category, "fest")
        self.assertEqual(signal.campus_id, "vnr_vjiet")
        self.assertEqual(signal.author_handle, "Sneha Reddy")
        self.assertIsNotNone(signal.geo)
        self.assertAlmostEqual(signal.geo.lat, 17.5399, places=3)


class TestMeilisearchClientQueue(unittest.TestCase):
    def test_micro_batch_queue(self):
        client = MeilisearchClient(host="http://localhost:7700")
        self.assertEqual(len(client.batch_queue), 0)

        # Enqueue item
        dummy_doc = {"id": "test_1", "title": "Test Event"}
        client.enqueue_document(dummy_doc, auto_flush_threshold=100)
        self.assertEqual(len(client.batch_queue), 1)

    def test_search_filter_construction(self):
        client = MeilisearchClient(host="http://localhost:7700")
        
        # Test that search doesn't throw on formatting
        query_payload = {}
        filters = []
        campus_id = "cbit_hyderabad"
        geo_radius = (17.3917, 78.3197, 5000)

        filters.append(f'campus_id = "{campus_id}"')
        filters.append(f'_geoRadius({geo_radius[0]}, {geo_radius[1]}, {geo_radius[2]})')
        filter_expr = " AND ".join(filters)

        self.assertEqual(
            filter_expr,
            'campus_id = "cbit_hyderabad" AND _geoRadius(17.3917, 78.3197, 5000)'
        )


class TestAmbassadorLoopService(unittest.TestCase):
    def test_inbound_submission_flow(self):
        service = AmbassadorLoopService()
        submission = AmbassadorSubmission(
            submission_id="sub_999",
            ambassador_id="amb_456",
            ambassador_name="Aditya Verma",
            campus_id="iit_hyderabad",
            campaign_task_id="task_social_blast_01",
            caption_text="Status updated with HackMIT poster!"
        )

        # Auto-index disabled for mock test (no live Meilisearch running)
        result = service.handle_inbound_submission(submission, auto_index=False)

        self.assertEqual(result["submission_id"], "sub_999")
        self.assertTrue(result["verification"]["is_valid"])
        self.assertEqual(result["signal"]["campus_id"], "iit_hyderabad")
        self.assertEqual(result["signal"]["_geo"]["lat"], 17.5947)


if __name__ == "__main__":
    unittest.main()
