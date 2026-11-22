"""
Live Gateway handshake test for CampusGTMBot.
Connects to Discord Gateway, verifies presence, and disconnects gracefully.
"""

import os
import sys
import asyncio
import discord

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import env_loader

async def test_gateway_handshake():
    token = os.environ.get("DISCORD_BOT_TOKEN", "").strip()
    if not token:
        print("❌ DISCORD_BOT_TOKEN not found.")
        return False

    intents = discord.Intents.default()
    intents.messages = True
    intents.message_content = True
    intents.guilds = True

    client = discord.Client(intents=intents)

    @client.event
    async def on_ready():
        print(f"✅ Gateway Connected! Logged in as: {client.user} (ID: {client.user.id})")
        print(f"📡 Connected to {len(client.guilds)} Discord server(s):")
        for g in client.guilds:
            print(f"   - {g.name} (ID: {g.id}, Members: {g.member_count})")
        
        # Disconnect gracefully after confirming handshake
        await asyncio.sleep(1)
        await client.close()

    try:
        await client.start(token)
        return True
    except discord.errors.PrivilegedIntentsRequired:
        print("⚠️ Warning: Privileged Intents (Message Content Intent) not enabled in Discord Developer Portal.")
        print("👉 Go to https://discord.com/developers/applications -> Bot -> Enable 'Message Content Intent'")
        return False
    except Exception as e:
        print(f"❌ Error during Gateway handshake: {e}")
        return False

if __name__ == "__main__":
    asyncio.run(test_gateway_handshake())
