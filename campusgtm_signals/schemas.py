"""
Data Schemas for CampusGTM Ingestion and Meilisearch Indexing.
"""

from typing import List, Optional, Dict, Any, Literal
import time
import hashlib
import json

PlatformType = Literal['whatsapp', 'telegram', 'discord', 'reddit', 'x', 'instagram', 'facebook']
CategoryType = Literal['hackathon', 'fest', 'workshop', 'student_inquiry', 'ambassador_ugc', 'brand_mention', 'general']
SentimentType = Literal['positive', 'neutral', 'negative']
VerificationStatus = Literal['pending', 'verified', 'rejected']


class GeoPoint:
    def __init__(self, lat: float, lng: float):
        self.lat = lat
        self.lng = lng

    def to_dict(self) -> Dict[str, float]:
        return {"lat": self.lat, "lng": self.lng}


class CampusSignal:
    """
    Standardized signal format indexed into Meilisearch and persisted in database.
    """
    def __init__(
        self,
        platform: PlatformType,
        external_id: str,
        campus_id: str,
        campus_name: str,
        title: str,
        body: str,
        author_handle: str,
        media_urls: Optional[List[str]] = None,
        source_url: Optional[str] = None,
        posted_at: Optional[int] = None,
        is_ambassador: bool = False,
        ambassador_id: Optional[str] = None,
        category: CategoryType = "general",
        sentiment: SentimentType = "neutral",
        extracted_entities: Optional[Dict[str, Any]] = None,
        geo: Optional[GeoPoint] = None,
        verification_status: VerificationStatus = "verified",
        confidence_score: float = 1.0
    ):
        # Deterministic primary key for Meilisearch idempotency
        self.id = f"{platform}_{hashlib.md5(external_id.encode('utf-8')).hexdigest()[:16]}"
        self.platform = platform
        self.external_id = external_id
        self.campus_id = campus_id
        self.campus_name = campus_name
        self.title = title
        self.body = body
        self.author_handle = author_handle
        self.media_urls = media_urls or []
        self.source_url = source_url or ""
        self.posted_at = posted_at or int(time.time())
        self.is_ambassador = is_ambassador
        self.ambassador_id = ambassador_id
        self.category = category
        self.sentiment = sentiment
        self.extracted_entities = extracted_entities or {
            "clubs": [],
            "fests": [],
            "dates_mentioned": [],
            "competitors": []
        }
        self.geo = geo
        self.verification_status = verification_status
        self.confidence_score = confidence_score

    def to_meili_doc(self) -> Dict[str, Any]:
        """Serializes to Meilisearch document format, including _geo."""
        doc = {
            "id": self.id,
            "platform": self.platform,
            "campus_id": self.campus_id,
            "campus_name": self.campus_name,
            "title": self.title,
            "body": self.body,
            "author_handle": self.author_handle,
            "media_urls": self.media_urls,
            "source_url": self.source_url,
            "posted_at": self.posted_at,
            "is_ambassador": self.is_ambassador,
            "ambassador_id": self.ambassador_id,
            "category": self.category,
            "sentiment": self.sentiment,
            "extracted_entities": self.extracted_entities,
            "verification_status": self.verification_status,
            "confidence_score": self.confidence_score
        }
        if self.geo:
            doc["_geo"] = self.geo.to_dict()
        return doc


class AmbassadorSubmission:
    """
    Inbound payload from student ambassadors via WhatsApp / Web portal.
    """
    def __init__(
        self,
        submission_id: str,
        ambassador_id: str,
        ambassador_name: str,
        campus_id: Optional[str] = None,
        campaign_task_id: Optional[str] = None,
        image_base64: Optional[str] = None,
        image_url: Optional[str] = None,
        caption_text: Optional[str] = None,
        submitted_at: Optional[int] = None
    ):
        self.submission_id = submission_id
        self.ambassador_id = ambassador_id
        self.ambassador_name = ambassador_name
        self.campus_id = campus_id
        self.campaign_task_id = campaign_task_id
        self.image_base64 = image_base64
        self.image_url = image_url
        self.caption_text = caption_text or ""
        self.submitted_at = submitted_at or int(time.time())


class TaskVerificationResult:
    """
    Result of automated task verification.
    """
    def __init__(
        self,
        is_valid: bool,
        confidence: float,
        reasons: List[str],
        extracted_title: Optional[str] = None,
        extracted_campus: Optional[str] = None,
        detected_category: CategoryType = "ambassador_ugc",
        proof_details: Optional[Dict[str, Any]] = None
    ):
        self.is_valid = is_valid
        self.confidence = confidence
        self.reasons = reasons
        self.extracted_title = extracted_title
        self.extracted_campus = extracted_campus
        self.detected_category = detected_category
        self.proof_details = proof_details or {}

    def to_dict(self) -> Dict[str, Any]:
        return {
            "is_valid": self.is_valid,
            "confidence": self.confidence,
            "reasons": self.reasons,
            "extracted_title": self.extracted_title,
            "extracted_campus": self.extracted_campus,
            "detected_category": self.detected_category,
            "proof_details": self.proof_details
        }
