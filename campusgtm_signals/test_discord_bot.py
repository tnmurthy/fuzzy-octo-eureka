"""
Unit Tests for CampusGTM Discord Bot Connector.
"""

import sys
import os
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from discord_bot import (
    is_target_channel,
    classify_message_intent,
    process_discord_message,
    GUILD_TO_CAMPUS_MAP
)
from campus_registry import get_campus_by_id


class TestDiscordBotLogic(unittest.TestCase):
    def test_target_channel_filtering(self):
        # Target channels
        self.assertTrue(is_target_channel("announcements"))
        self.assertTrue(is_target_channel("college-events"))
        self.assertTrue(is_target_channel("hackathons-2026"))
        self.assertTrue(is_target_channel("general-chat"))
        self.assertTrue(is_target_channel("notice-board"))

        # Non-target channels
        self.assertFalse(is_target_channel("random-memes"))
        self.assertFalse(is_target_channel("music-bot-commands"))
        self.assertFalse(is_target_channel("gaming-lounge"))

    def test_classify_message_intent(self):
        # Hackathon
        cat, kw = classify_message_intent("Registration for HackVerse 2026 is officially open!")
        self.assertEqual(cat, "hackathon")
        self.assertIn("hackathon", kw)

        # Workshop
        cat, kw = classify_message_intent("Join us for a hands-on workshop on PyTorch and LLMs.")
        self.assertEqual(cat, "workshop")
        self.assertIn("workshop", kw)

        # Fest
        cat, kw = classify_message_intent("Get ready for the annual techno-cultural fest next month!")
        self.assertEqual(cat, "fest")
        self.assertIn("fest", kw)

        # General
        cat, kw = classify_message_intent("Hey is anyone free to play badminton today?")
        self.assertEqual(cat, "general")
        self.assertEqual(len(kw), 0)

    def test_process_discord_message_with_text_campus(self):
        signal = process_discord_message(
            message_id="1122334455",
            channel_name="announcements",
            author_name="cbit_student#1234",
            author_id="99887766",
            content="CBIT Hackathon 2026 is happening this weekend! Register now at https://cbit.ac.in/hack",
            guild_id="555666777",
            guild_name="CBIT Developers Club",
            attachments=[],
            created_at_ts=1732000000
        )

        self.assertIsNotNone(signal)
        self.assertEqual(signal.platform, "discord")
        self.assertEqual(signal.campus_id, "cbit_hyderabad")
        self.assertEqual(signal.category, "hackathon")
        self.assertIsNotNone(signal.geo)
        self.assertAlmostEqual(signal.geo.lat, 17.3917, places=3)
        self.assertAlmostEqual(signal.geo.lng, 78.3197, places=3)

    def test_process_discord_message_with_guild_mapping(self):
        # Map a guild ID directly
        guild_id = "888899991111"
        GUILD_TO_CAMPUS_MAP[guild_id] = "iit_hyderabad"

        signal = process_discord_message(
            message_id="77889900",
            channel_name="events",
            author_name="ambassador_bob#4321",
            author_id="11221122",
            content="Campus ambassador task completed! Shared the registration link with all batches.",
            guild_id=guild_id,
            guild_name="IITH Student Council",
            attachments=[],
            created_at_ts=1732000100
        )

        self.assertIsNotNone(signal)
        self.assertEqual(signal.campus_id, "iit_hyderabad")
        self.assertEqual(signal.category, "ambassador_ugc")
        self.assertTrue(signal.is_ambassador)
        self.assertAlmostEqual(signal.geo.lat, 17.5947, places=3)

    def test_process_discord_message_attachment_fallback(self):
        # Message with no body but with an image flyer attachment in #announcements
        attachments = [
            {
                "url": "https://cdn.discordapp.com/attachments/123/456/flyer.png",
                "content_type": "image/png",
                "filename": "flyer.png"
            }
        ]

        signal = process_discord_message(
            message_id="999888777",
            channel_name="announcements",
            author_name="design_lead#5678",
            author_id="33445566",
            content="",
            guild_id="12345",
            guild_name="Osmania University Coding Club",
            attachments=attachments
        )

        self.assertIsNotNone(signal)
        self.assertEqual(signal.campus_id, "osmania_university")
        self.assertEqual(len(signal.media_urls), 1)
        self.assertIn("flyer.png", signal.media_urls[0])

    def test_ignore_irrelevant_chatter(self):
        # Casual message in non-target channel should be filtered out
        signal = process_discord_message(
            message_id="000111222",
            channel_name="random-memes",
            author_name="gamer#0001",
            author_id="44556677",
            content="lol that exam was so difficult",
            guild_id="999",
            guild_name="Some Server",
            attachments=[]
        )

        self.assertIsNone(signal)


if __name__ == "__main__":
    unittest.main()
