"""
Diagnostic script to test Discord Bot Authentication & Token Validity.
"""

import os
import sys
import json
import urllib.request
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import env_loader

def test_discord_token():
    token = os.environ.get("DISCORD_BOT_TOKEN", "").strip()
    if not token:
        print("❌ FAIL: DISCORD_BOT_TOKEN is not set or empty in environment.")
        return False

    print(f"🔑 Token loaded successfully (Length: {len(token)}, Prefix: {token[:8]}...)")

    # Verify directly against Discord REST API
    url = "https://discord.com/api/v10/users/@me"
    headers = {
        "Authorization": f"Bot {token}",
        "User-Agent": "CampusGTM-Diagnostic/1.0"
    }

    req = urllib.request.Request(url, headers=headers, method="GET")

    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            if response.status == 200:
                data = json.loads(response.read().decode("utf-8"))
                username = data.get("username")
                discriminator = data.get("discriminator", "0")
                bot_id = data.get("id")
                is_bot = data.get("bot", False)

                print("✅ SUCCESS: Successfully authenticated with Discord Gateway!")
                print(f"🤖 Bot Username: {username}#{discriminator}")
                print(f"🆔 Bot ID:       {bot_id}")
                print(f"✨ Is Bot Account: {is_bot}")
                return True
            else:
                print(f"⚠️ Unexpected status code: {response.status}")
                return False
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8")
        print(f"❌ HTTP Error {e.code}: {e.reason}")
        print(f"Details: {error_body}")
        return False
    except Exception as e:
        print(f"❌ Connection Error: {e}")
        return False

if __name__ == "__main__":
    success = test_discord_token()
    sys.exit(0 if success else 1)
