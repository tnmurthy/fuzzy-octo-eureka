"""
Initialize campus_signals index and seed initial sample campus events.
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from meilisearch_client import MeilisearchClient
from schemas import CampusSignal, GeoPoint

def seed():
    client = MeilisearchClient()
    print("1. Initializing index settings...")
    client.init_index()

    print("2. Seeding initial campus events...")
    signals = [
        CampusSignal(
            platform="discord",
            external_id="seed_001",
            campus_id="cbit_hyderabad",
            campus_name="Chaitanya Bharathi Institute of Technology",
            title="CBIT Hackathon 2026 - AI & Web3",
            body="Annual 36-hour national level hackathon organized by ACM student chapter. ₹1,50,000 prize pool.",
            author_handle="acm_lead",
            category="hackathon",
            geo=GeoPoint(lat=17.3917, lng=78.3197),
            posted_at=int(time.time())
        ),
        CampusSignal(
            platform="discord",
            external_id="seed_002",
            campus_id="iit_hyderabad",
            campus_name="Indian Institute of Technology Hyderabad",
            title="IIT-H HackVerse 2026",
            body="Build autonomous agents and AI robotics at the Kandi campus hackathon. Food and swags provided.",
            author_handle="iith_council",
            category="hackathon",
            geo=GeoPoint(lat=17.5947, lng=78.1230),
            posted_at=int(time.time())
        ),
        CampusSignal(
            platform="discord",
            external_id="seed_003",
            campus_id="vnr_vjiet",
            campus_name="VNR Vignana Jyothi Institute of Engineering and Technology",
            title="Autonomous Agents & LLM Masterclass",
            body="Hands-on workshop on PyTorch, function calling, and vector search with Meilisearch.",
            author_handle="ieee_vnr",
            category="workshop",
            geo=GeoPoint(lat=17.5399, lng=78.3862),
            posted_at=int(time.time())
        )
    ]

    for s in signals:
        client.enqueue_document(s.to_meili_doc())
    
    res = client.flush()
    print("3. Flush task result:", res)
    print("✅ Index initialized and 3 sample campus signals seeded successfully!")

if __name__ == "__main__":
    seed()
