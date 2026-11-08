#!/usr/bin/env bash
if [ -d "$HOME/.nvm/versions/node" ]; then
  LATEST_NODE=$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | tail -n 1)
  [ -n "$LATEST_NODE" ] && export PATH="$HOME/.nvm/versions/node/$LATEST_NODE/bin:$PATH"
fi
export PATH="$HOME/.local/bin:$PATH"
exec openclaw gateway --port 18789 --allow-unconfigured --auth none

