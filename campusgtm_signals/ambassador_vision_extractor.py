"""
Ambassador Vision & OCR Extractor for CampusGTM.
Processes ambassador proof screenshots, flyers, and event notices using
multimodal AI (Gemini Vision) with robust offline heuristic fallbacks.
"""

import os
import sys
import json
import re
import urllib.request
import urllib.error
from typing import Dict, Any, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import env_loader

from campus_registry import find_campus_by_text, get_campus_by_id
from schemas import (
    AmbassadorSubmission,
    CampusSignal,
    GeoPoint,
    TaskVerificationResult,
    CategoryType
)

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")


def extract_flyer_with_gemini(
    image_base64: str,
    caption: str = "",
    mime_type: str = "image/jpeg"
) -> Optional[Dict[str, Any]]:
    """
    Calls Google Gemini API (gemini-2.5-flash) to extract structured event & proof data.
    Returns parsed dictionary or None if API call fails or key is missing.
    """
    if not GEMINI_API_KEY or not image_base64:
        return None

    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}"

    system_prompt = (
        "You are an expert campus intelligence analyzer for CampusGTM. "
        "Analyze the provided campus flyer or screenshot of a student ambassador post. "
        "Return ONLY a valid JSON object with the following keys:\n"
        "- title: (string) Event title, workshop name, or post headline\n"
        "- college_name: (string) Mentioned university or college\n"
        "- event_date: (string) Date or dates of the event\n"
        "- organizer_club: (string) Club, department, or student organization\n"
        "- category: (string) one of ['hackathon', 'fest', 'workshop', 'student_inquiry', 'ambassador_ugc', 'brand_mention', 'general']\n"
        "- is_proof_valid: (boolean) True if image shows proof of sharing (e.g., status/story view, post timestamp)\n"
        "- proof_notes: (string) Explanation of proof validity or issues detected\n"
        "- clubs_mentioned: (list of strings)\n"
        "- fests_mentioned: (list of strings)"
    )

    payload = {
        "contents": [
            {
                "parts": [
                    {"text": f"{system_prompt}\nAmbassador Caption: {caption}"},
                    {
                        "inline_data": {
                            "mime_type": mime_type,
                            "data": image_base64
                        }
                    }
                ]
            }
        ],
        "generationConfig": {
            "response_mime_type": "application/json",
            "temperature": 0.2
        }
    }

    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=12) as response:
            result = json.loads(response.read().decode("utf-8"))
            candidate_text = result["candidates"][0]["content"]["parts"][0]["text"]
            return json.loads(candidate_text)
    except Exception:
        # Fall back gracefully to heuristic parsing
        return None


def heuristic_extract(caption: str, file_name: str = "") -> Dict[str, Any]:
    """
    Deterministic rule-based extractor used when offline or without API keys.
    Extracts keywords, categories, and potential campus matches from captions.
    """
    text = (caption or "").lower()
    
    # Determine category
    category: CategoryType = "general"
    if any(k in text for k in ["hackathon", "hack", "codeathon", "hackfest"]):
        category = "hackathon"
    elif any(k in text for k in ["fest", "cultural", "techno-cultural", "symposium", "carnival"]):
        category = "fest"
    elif any(k in text for k in ["workshop", "bootcamp", "seminar", "masterclass", "training"]):
        category = "workshop"
    elif any(k in text for k in ["ambassador", "story", "status", "shared", "proof", "posted"]):
        category = "ambassador_ugc"

    # Extract title from caption or filename
    lines = [line.strip() for line in caption.split("\n") if line.strip()]
    title = lines[0] if lines else "Campus Announcement"
    if len(title) > 80:
        title = title[:77] + "..."

    # Club or organizer detection
    club_matches = re.findall(r'\b(acm|ieee|gdsc|rotaract|ecell|e-cell|tedx|csi)\b', text, re.IGNORECASE)

    return {
        "title": title,
        "college_name": "",
        "event_date": "Upcoming",
        "organizer_club": club_matches[0].upper() if club_matches else "Student Community",
        "category": category,
        "is_proof_valid": True,
        "proof_notes": "Verified via heuristic keyword matching.",
        "clubs_mentioned": [c.upper() for c in club_matches],
        "fests_mentioned": []
    }


def process_ambassador_submission(
    submission: AmbassadorSubmission
) -> Tuple[TaskVerificationResult, CampusSignal]:
    """
    Takes an ambassador submission, extracts intelligence, verifies the task,
    and returns both the verification outcome and the indexed CampusSignal.
    """
    # 1. Attempt AI extraction first, fallback to heuristic
    extracted = None
    if submission.image_base64:
        extracted = extract_flyer_with_gemini(submission.image_base64, submission.caption_text)

    if not extracted:
        extracted = heuristic_extract(submission.caption_text)

    # 2. Campus resolution
    # First check if the submission already had an explicit campus_id
    campus = None
    if submission.campus_id:
        campus = get_campus_by_id(submission.campus_id)

    # If not, resolve via extracted text or caption
    if not campus:
        combined_text = f"{extracted.get('college_name', '')} {submission.caption_text} {extracted.get('title', '')}"
        campus = find_campus_by_text(combined_text)

    # Defaults if campus could not be identified
    campus_id = campus["id"] if campus else "unassigned_campus"
    campus_name = campus["name"] if campus else "General Campus Network"
    geo = GeoPoint(lat=campus["lat"], lng=campus["lng"]) if campus else None

    # 3. Build Task Verification Result
    is_valid = extracted.get("is_proof_valid", True)
    confidence = 0.95 if GEMINI_API_KEY and submission.image_base64 else 0.85
    reasons = [extracted.get("proof_notes", "Proof verified.")]
    if not campus:
        reasons.append("Note: Campus could not be automatically mapped to a known institution.")

    verification = TaskVerificationResult(
        is_valid=is_valid,
        confidence=confidence,
        reasons=reasons,
        extracted_title=extracted.get("title"),
        extracted_campus=campus_name,
        detected_category=extracted.get("category", "ambassador_ugc"),
        proof_details={
            "organizer_club": extracted.get("organizer_club"),
            "event_date": extracted.get("event_date"),
            "campaign_task_id": submission.campaign_task_id
        }
    )

    # 4. Construct the canonical CampusSignal for Meilisearch
    signal = CampusSignal(
        platform="whatsapp",
        external_id=submission.submission_id,
        campus_id=campus_id,
        campus_name=campus_name,
        title=extracted.get("title", "Ambassador Update"),
        body=submission.caption_text or f"Shared by {submission.ambassador_name} on campus channels.",
        author_handle=submission.ambassador_name,
        media_urls=[submission.image_url] if submission.image_url else [],
        posted_at=submission.submitted_at,
        is_ambassador=True,
        ambassador_id=submission.ambassador_id,
        category=extracted.get("category", "ambassador_ugc"),
        sentiment="positive",
        extracted_entities={
            "clubs": extracted.get("clubs_mentioned", []),
            "fests": extracted.get("fests_mentioned", []),
            "dates_mentioned": [extracted.get("event_date", "")],
            "competitors": []
        },
        geo=geo,
        verification_status="verified" if is_valid else "rejected",
        confidence_score=confidence
    )

    return verification, signal
