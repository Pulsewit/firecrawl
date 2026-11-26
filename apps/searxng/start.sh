#!/bin/sh
# Starts SearXNG. When SEARXNG_PROXY_SERVER is set, its searches go through
# that proxy; otherwise it starts exactly as before.
set -eu

BAKED=/usr/local/searxng/firecrawl/settings.yml

if [ -n "${SEARXNG_PROXY_SERVER:-}" ]; then
    umask 077
    mkdir -p /tmp/searxng
    /usr/local/searxng/.venv/bin/python3 /usr/local/searxng/firecrawl/add_proxy.py \
        "$BAKED" /tmp/searxng/settings.yml
    chown -R searxng:searxng /tmp/searxng 2>/dev/null || true
    export SEARXNG_SETTINGS_PATH=/tmp/searxng/settings.yml
fi

exec /usr/local/searxng/entrypoint.sh
