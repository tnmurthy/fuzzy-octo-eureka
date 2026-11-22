"""
Environment and Secrets Loader for CampusGTM.
Automatically locates and parses .env files from the module directory,
the project root, and the secrets/ folder.
"""

import os
from typing import List


def load_env_file(file_path: str):
    """Parses a key=value .env file into os.environ if key is not already set."""
    if not os.path.isfile(file_path):
        return

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, val = line.split("=", 1)
                    key = key.strip()
                    val = val.strip().strip("'\"")
                    if key and key not in os.environ:
                        os.environ[key] = val
    except Exception:
        # Ignore unreadable files or permission issues
        pass


def load_all_env_sources():
    """Scans module .env, root .env, and all files in the secrets/ directory."""
    base_dir = os.path.dirname(os.path.abspath(__file__))
    
    # 1. Module-level .env
    load_env_file(os.path.join(base_dir, ".env"))

    # 2. Project root .env
    root_dir = os.path.abspath(os.path.join(base_dir, ".."))
    load_env_file(os.path.join(root_dir, ".env"))

    # 3. Check secrets/ directory in project root
    secrets_dir = os.path.join(root_dir, "secrets")
    if os.path.isdir(secrets_dir):
        try:
            for entry in os.listdir(secrets_dir):
                candidate = os.path.join(secrets_dir, entry)
                if os.path.isfile(candidate):
                    load_env_file(candidate)
        except Exception:
            pass

    # 4. Also check if SECRETS_ENV_FILE is explicitly defined
    custom_secrets = os.environ.get("SECRETS_ENV_FILE")
    if custom_secrets:
        load_env_file(custom_secrets)


# Auto-run on import
load_all_env_sources()
