"""
Campus Registry for CampusGTM
Maps college campuses, tech institutions, and universities to their geographical
coordinates, aliases, and regional metadata. Enables automatic campus association
and Meilisearch _geo indexing.
"""

from typing import Dict, List, Optional, Any
import re

CAMPUS_DATABASE: Dict[str, Dict[str, Any]] = {
    "iit_hyderabad": {
        "id": "iit_hyderabad",
        "name": "Indian Institute of Technology Hyderabad",
        "short_name": "IIT Hyderabad",
        "city": "Sangareddy",
        "state": "Telangana",
        "country": "India",
        "lat": 17.5947,
        "lng": 78.1230,
        "aliases": ["iith", "iit hyderabad", "iit-h", "kandi campus"]
    },
    "iiit_hyderabad": {
        "id": "iiit_hyderabad",
        "name": "International Institute of Information Technology Hyderabad",
        "short_name": "IIIT Hyderabad",
        "city": "Hyderabad",
        "state": "Telangana",
        "country": "India",
        "lat": 17.4455,
        "lng": 78.3489,
        "aliases": ["iiith", "iiit hyderabad", "iiit-h", "gachibowli campus"]
    },
    "cbit_hyderabad": {
        "id": "cbit_hyderabad",
        "name": "Chaitanya Bharathi Institute of Technology",
        "short_name": "CBIT Hyderabad",
        "city": "Hyderabad",
        "state": "Telangana",
        "country": "India",
        "lat": 17.3917,
        "lng": 78.3197,
        "aliases": ["cbit", "chaitanya bharathi", "cbit hyderabad", "gandipet"]
    },
    "vnr_vjiet": {
        "id": "vnr_vjiet",
        "name": "Vallurupalli Nageswara Rao Vignana Jyothi Institute of Engineering and Technology",
        "short_name": "VNR VJIET",
        "city": "Hyderabad",
        "state": "Telangana",
        "country": "India",
        "lat": 17.5399,
        "lng": 78.3862,
        "aliases": ["vnr", "vjiet", "vnr vjiet", "bachupally"]
    },
    "nit_warangal": {
        "id": "nit_warangal",
        "name": "National Institute of Technology Warangal",
        "short_name": "NIT Warangal",
        "city": "Warangal",
        "state": "Telangana",
        "country": "India",
        "lat": 17.9839,
        "lng": 79.5308,
        "aliases": ["nitw", "nit warangal", "rec warangal"]
    },
    "osmania_university": {
        "id": "osmania_university",
        "name": "Osmania University College of Engineering",
        "short_name": "OUCE Hyderabad",
        "city": "Hyderabad",
        "state": "Telangana",
        "country": "India",
        "lat": 17.4138,
        "lng": 78.5284,
        "aliases": ["ouce", "osmania university", "ou hyderabad", "osmania"]
    },
    "jntu_hyderabad": {
        "id": "jntu_hyderabad",
        "name": "Jawaharlal Nehru Technological University Hyderabad",
        "short_name": "JNTUH",
        "city": "Hyderabad",
        "state": "Telangana",
        "country": "India",
        "lat": 17.4933,
        "lng": 78.3914,
        "aliases": ["jntuh", "jntu hyderabad", "jntu kukatpally"]
    },
    "bits_pilani_hyderabad": {
        "id": "bits_pilani_hyderabad",
        "name": "Birla Institute of Technology and Science Pilani, Hyderabad Campus",
        "short_name": "BITS Hyderabad",
        "city": "Hyderabad",
        "state": "Telangana",
        "country": "India",
        "lat": 17.5449,
        "lng": 78.5718,
        "aliases": ["bphc", "bits hyderabad", "bits pilani hyderabad", "shameerpet"]
    }
}


def find_campus_by_text(text: str) -> Optional[Dict[str, Any]]:
    """
    Scans a given text or flyer transcription for mentions of known colleges/universities.
    Returns the campus dictionary if a match is found, else None.
    """
    if not text:
        return None

    cleaned_text = text.lower()
    for campus_id, data in CAMPUS_DATABASE.items():
        # Check direct short name or id
        if campus_id in cleaned_text or data["name"].lower() in cleaned_text:
            return data
        
        # Check aliases with word boundary matching
        for alias in data["aliases"]:
            pattern = r'\b' + re.escape(alias.lower()) + r'\b'
            if re.search(pattern, cleaned_text):
                return data

    return None


def get_campus_by_id(campus_id: str) -> Optional[Dict[str, Any]]:
    """Retrieve campus metadata by its canonical ID."""
    return CAMPUS_DATABASE.get(campus_id)


def list_all_campuses() -> List[Dict[str, Any]]:
    """Returns a list of all registered campuses."""
    return list(CAMPUS_DATABASE.values())
