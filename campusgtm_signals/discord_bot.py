"""
CampusGTM Discord Bot Connector.
Listens to campus club, department, and student community Discord servers.
Captures event announcements, hackathon flyers, student inquiries, and ambassador updates,
then normalizes and indexes them into Meilisearch with campus geosearch tagging.
"""

import os
import sys
import re
import json
import time
from typing import Dict, Any, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Auto-load environment variables from module .env, root .env, and secrets/
import env_loader

from campus_registry import find_campus_by_text, get_campus_by_id
from schemas import CampusSignal, GeoPoint, CategoryType
from meilisearch_client import MeilisearchClient

DISCORD_BOT_TOKEN = os.environ.get("DISCORD_BOT_TOKEN", "")

# High-signal channels to monitor
TARGET_CHANNEL_PATTERNS = [
    r'announcement',
    r'event',
    r'hackathon',
    r'opportunity',
    r'workshop',
    r'general',
    r'notice-board',
    r'campus-buzz'
]

# High-intent campus keywords
INTENT_KEYWORDS = {
    "hackathon": ["hackathon", "hackfest", "codeathon", "hack-night", "devpost"],
    "fest": ["fest", "techno-cultural", "symposium", "annual fest", "carnival"],
    "workshop": ["workshop", "bootcamp", "hands-on", "masterclass", "seminar", "webinar"],
    "ambassador_ugc": ["campus ambassador", "ambassador task", "campus lead", "swag", "bounty"],
    "student_inquiry": ["is anyone attending", "who is going to", "need team for", "looking for teammates"]
}

# Known Discord Guild ID -> Canonical Campus ID mapping
GUILD_TO_CAMPUS_MAP: Dict[str, str] = {
    # Examples:
    # "123456789012345678": "iit_hyderabad",
    # "234567890123456789": "cbit_hyderabad",
}


def is_target_channel(channel_name: str) -> bool:
    """Checks if a channel name matches our target monitoring patterns."""
    if not channel_name:
        return False
    name_lower = channel_name.lower()
    return any(re.search(pat, name_lower) for pat in TARGET_CHANNEL_PATTERNS)


def classify_message_intent(text: str) -> Tuple[CategoryType, List[str]]:
    """
    Classifies a Discord message into a category and extracts matched keywords.
    """
    if not text:
        return "general", []

    text_lower = text.lower()
    matched_keywords = []

    for category, keywords in INTENT_KEYWORDS.items():
        for kw in keywords:
            if re.search(r'\b' + re.escape(kw) + r'\b', text_lower):
                matched_keywords.append(kw)
                return category, matched_keywords  # Priority matching

    return "general", matched_keywords


def process_discord_message(
    message_id: str,
    channel_name: str,
    author_name: str,
    author_id: str,
    content: str,
    guild_id: Optional[str] = None,
    guild_name: Optional[str] = None,
    attachments: Optional[List[Dict[str, Any]]] = None,
    created_at_ts: Optional[int] = None
) -> Optional[CampusSignal]:
    """
    Core message processor. Evaluates relevance, resolves campus,
    attaches geocodes, and builds a standardized CampusSignal.
    Returns None if message is low-intent and contains no target keywords.
    """
    attachments = attachments or []
    has_image_attachment = any(
        att.get("content_type", "").startswith("image/") or
        att.get("url", "").lower().endswith((".png", ".jpg", ".jpeg", ".webp"))
        for att in attachments
    )

    # Filter out empty or irrelevant messages unless they contain image attachments in an announcement channel
    category, matched_keywords = classify_message_intent(content)
    if category == "general" and not has_image_attachment and not is_target_channel(channel_name):
        return None

    # Resolve Campus:
    # 1. Guild ID explicit mapping
    campus = None
    if guild_id and guild_id in GUILD_TO_CAMPUS_MAP:
        campus = get_campus_by_id(GUILD_TO_CAMPUS_MAP[guild_id])

    # 2. Textual matching in content or guild name
    if not campus:
        context_text = f"{content} {guild_name or ''} {channel_name}"
        campus = find_campus_by_text(context_text)

    campus_id = campus["id"] if campus else "unassigned_campus"
    campus_name = campus["name"] if campus else (guild_name or "Discord Campus Hub")
    geo = GeoPoint(lat=campus["lat"], lng=campus["lng"]) if campus else None

    # Derive Title
    lines = [l.strip() for l in content.split("\n") if l.strip()]
    if lines:
        title = lines[0][:80]
    elif has_image_attachment:
        title = f"Campus Poster in #{channel_name}"
    else:
        title = f"Announcement in #{channel_name}"

    # Extract media URLs
    media_urls = [att.get("url") for att in attachments if att.get("url")]

    signal = CampusSignal(
        platform="discord",
        external_id=str(message_id),
        campus_id=campus_id,
        campus_name=campus_name,
        title=title,
        body=content or f"Attachment posted by {author_name} in #{channel_name}",
        author_handle=author_name,
        media_urls=media_urls,
        source_url=f"https://discord.com/channels/{guild_id or '@me'}/{channel_name}/{message_id}",
        posted_at=created_at_ts or int(time.time()),
        is_ambassador=(category == "ambassador_ugc"),
        category=category,
        sentiment="positive" if category in ["hackathon", "fest", "workshop"] else "neutral",
        extracted_entities={
            "matched_keywords": matched_keywords,
            "channel": channel_name,
            "guild_name": guild_name or ""
        },
        geo=geo,
        verification_status="verified",
        confidence_score=0.9 if campus else 0.75
    )

    return signal


# --- Live Discord Bot Client (when discord.py is installed) ---
try:
    import discord
    from discord.ext import commands
    HAS_DISCORD_LIB = True
except ImportError:
    HAS_DISCORD_LIB = False


class CampusGTMDiscordBot:
    """Wrapper managing live Discord Gateway connection and event handling."""
    def __init__(self, token: str = DISCORD_BOT_TOKEN, meili_client: Optional[MeilisearchClient] = None):
        self.token = token
        self.meili_client = meili_client or MeilisearchClient()
        self.bot = None

        if HAS_DISCORD_LIB:
            intents = discord.Intents.default()
            intents.messages = True
            intents.message_content = True
            intents.guilds = True

            self.bot = commands.Bot(command_prefix="!gtm ", intents=intents)
            self._register_handlers()

    def _register_handlers(self):
        if not self.bot:
            return

        @self.bot.event
        async def on_ready():
            print(f"[CampusGTM Discord Bot] Logged in as {self.bot.user} (ID: {self.bot.user.id})")
            try:
                synced = await self.bot.tree.sync()
                print(f"[CampusGTM Discord Bot] Synced {len(synced)} slash commands.")
            except Exception as e:
                print(f"[CampusGTM Discord Bot] Error syncing slash commands: {e}")

        @self.bot.event
        async def on_message(message: discord.Message):
            # Ignore messages sent by bots
            if message.author.bot:
                return

            channel_name = getattr(message.channel, 'name', '')
            guild_id = str(message.guild.id) if message.guild else None
            guild_name = message.guild.name if message.guild else None

            attachments = [
                {
                    "url": att.url,
                    "content_type": att.content_type or "",
                    "filename": att.filename
                }
                for att in message.attachments
            ]

            signal = process_discord_message(
                message_id=str(message.id),
                channel_name=channel_name,
                author_name=str(message.author),
                author_id=str(message.author.id),
                content=message.content,
                guild_id=guild_id,
                guild_name=guild_name,
                attachments=attachments,
                created_at_ts=int(message.created_at.timestamp())
            )

            if signal:
                # Enqueue directly into Meilisearch
                try:
                    self.meili_client.enqueue_document(signal.to_meili_doc())
                    print(f"[CampusGTM Discord Bot] Indexed signal: {signal.title} [{signal.campus_id}]")
                except Exception as err:
                    print(f"[CampusGTM Discord Bot] Failed to index document: {err}")

            await self.bot.process_commands(message)

        # Slash Command: /search-campus
        @self.bot.tree.command(name="search-campus", description="Search live campus events and buzz")
        async def search_campus(interaction: discord.Interaction, query: str):
            await interaction.response.defer()
            try:
                results = self.meili_client.search(query=query, limit=5)
                hits = results.get("hits", [])
                if not hits:
                    await interaction.followup.send(f"No campus signals found matching: **{query}**")
                    return

                embed = discord.Embed(
                    title=f"CampusGTM Search Results: {query}",
                    color=0x4F46E5
                )
                for hit in hits[:5]:
                    campus = hit.get("campus_name", "Unknown Campus")
                    cat = hit.get("category", "General").capitalize()
                    embed.add_field(
                        name=f"[{cat}] {hit.get('title', 'Event')}",
                        value=f"🏛️ **{campus}**\n📝 {hit.get('body', '')[:120]}...",
                        inline=False
                    )
                await interaction.followup.send(embed=embed)
            except Exception as e:
                await interaction.followup.send(f"Search failed: {str(e)}")

        # Slash Command: /map-campus
        @self.bot.tree.command(name="map-campus", description="Link this Discord server to a Campus ID")
        async def map_campus(interaction: discord.Interaction, campus_id: str):
            campus = get_campus_by_id(campus_id)
            if not campus:
                await interaction.response.send_message(
                    f"❌ Unknown campus ID: `{campus_id}`. Please check `campus_registry`.",
                    ephemeral=True
                )
                return

            if interaction.guild:
                GUILD_TO_CAMPUS_MAP[str(interaction.guild.id)] = campus_id
                await interaction.response.send_message(
                    f"✅ Successfully linked server **{interaction.guild.name}** to **{campus['name']}**!",
                    ephemeral=False
                )
            else:
                await interaction.response.send_message("This command must be run inside a Discord server.", ephemeral=True)

    def start(self):
        """Starts the bot using the configured token."""
        if not HAS_DISCORD_LIB:
            print("[CampusGTM Discord Bot] Error: 'discord.py' is not installed. Install with: pip install discord.py")
            return
        if not self.token:
            print("[CampusGTM Discord Bot] Error: DISCORD_BOT_TOKEN environment variable not set.")
            return

        self.bot.run(self.token)


if __name__ == "__main__":
    bot = CampusGTMDiscordBot()
    bot.start()

