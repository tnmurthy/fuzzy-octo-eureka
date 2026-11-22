"""
Send test greeting to #general in Drisyon's server.
"""

import os
import sys
import asyncio
import discord

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import env_loader

async def send_hello():
    token = os.environ.get("DISCORD_BOT_TOKEN", "").strip()
    intents = discord.Intents.default()
    intents.messages = True
    intents.message_content = True
    intents.guilds = True

    client = discord.Client(intents=intents)

    @client.event
    async def on_ready():
        for guild in client.guilds:
            for ch in guild.text_channels:
                if ch.name == "general":
                    embed = discord.Embed(
                        title="🚀 CampusGTM Bot Online!",
                        description=(
                            "Hello Drisyon! I am connected and listening to campus buzz, "
                            "hackathon announcements, and student ambassador updates.\n\n"
                            "**Features Active:**\n"
                            "• Campus Intent Classification (Hackathons, Fests, Workshops)\n"
                            "• Instant Geosearch & Proximity Matching\n"
                            "• Real-time Meilisearch Pipeline"
                        ),
                        color=0x4F46E5
                    )
                    await ch.send(embed=embed)
                    print(f"Sent greeting embed to #{ch.name} in {guild.name}")
        await client.close()

    await client.start(token)

if __name__ == "__main__":
    asyncio.run(send_hello())
