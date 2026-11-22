"""
Inspect channels in Drisyon's server.
"""

import os
import sys
import asyncio
import discord

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import env_loader

async def inspect_server():
    token = os.environ.get("DISCORD_BOT_TOKEN", "").strip()
    intents = discord.Intents.default()
    intents.messages = True
    intents.message_content = True
    intents.guilds = True

    client = discord.Client(intents=intents)

    @client.event
    async def on_ready():
        for guild in client.guilds:
            print(f"\n🏰 Server: {guild.name} (ID: {guild.id})")
            print("Channels:")
            for ch in guild.text_channels:
                print(f"  - #{ch.name} (ID: {ch.id})")
        await client.close()

    await client.start(token)

if __name__ == "__main__":
    asyncio.run(inspect_server())
