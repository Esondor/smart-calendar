#!/bin/sh
# Starts as root only to make the data folder writable (e.g. a folder created in DSM File Station),
# then drops to the unprivileged "node" user for the actual app.
set -e
DATA="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA"
  chown -R node:node "$DATA" 2>/dev/null || true
  # the app's folder (data + backups, the backup folder is chosen in Administration)
  if [ -n "$STORE_DIR" ] || [ "$(dirname "$DATA")" = "/store" ]; then chown -R node:node "$(dirname "$DATA")" 2>/dev/null || true; fi
  if ! su-exec node sh -c "touch '$DATA/.write-test' && rm -f '$DATA/.write-test'"; then
    echo ""
    echo "  ERROR: the data folder ($DATA on the container side) is not writable."
    echo "  In DSM File Station: right-click the data folder → Properties → Permission →"
    echo "  Create → User or group: Everyone → Read & Write, apply to this folder, sub-folders and files."
    echo ""
    exit 1
  fi
  exec su-exec node "$@"
fi
exec "$@"
