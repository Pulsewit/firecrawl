# SearXNG for Firecrawl's search (SEARXNG_ENDPOINT).
# Bakes the settings into the image so they don't depend on the
# /etc/searxng volume, which keeps whatever settings.yml it was first given.
FROM searxng/searxng:latest

COPY settings.yml /usr/local/searxng/firecrawl/settings.yml
COPY add_proxy.py /usr/local/searxng/firecrawl/add_proxy.py
COPY --chmod=755 start.sh /usr/local/searxng/firecrawl/start.sh
ENV SEARXNG_SETTINGS_PATH=/usr/local/searxng/firecrawl/settings.yml

# Adds the proxy from SEARXNG_PROXY_* when set, then runs SearXNG's own entrypoint.
ENTRYPOINT ["/usr/local/searxng/firecrawl/start.sh"]
