#!/bin/sh
# A09 / A21: prepare /app/data, then exec the command (default: node dist/index.js).
set -eu

DATA="${DATA_DIR:-/app/data}"
SANDBOX_USER=sandbox

mkdir -p "$DATA" "$DATA/skills" "$DATA/workspace" "$DATA/browser-profile"

# Everything except workspace/: owned by the app user (root), no access for others.
find "$DATA" -mindepth 1 -maxdepth 1 ! -name workspace -exec chown -R root:root {} +
find "$DATA" -mindepth 1 -maxdepth 1 ! -name workspace -exec chmod -R go-rwx {} +

# workspace/ belongs to the sandbox user.
chown -R "$SANDBOX_USER:$SANDBOX_USER" "$DATA/workspace"
chmod 700 "$DATA/workspace"

# The data dir itself must be traversable (--x) so sandbox can reach workspace/,
# but not listable or writable. Contents above are 700, so they stay unreadable.
chown root:root "$DATA"
chmod 711 "$DATA"

# A21: mounted volume owner differs from the container user.
# Idempotent: --add would append a duplicate line on every boot.
if ! git config --global --get-all safe.directory | grep -qxF "$DATA"; then
  git config --global --add safe.directory "$DATA"
fi

exec "$@"
