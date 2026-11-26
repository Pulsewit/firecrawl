# SearXNG for Firecrawl's search (SEARXNG_ENDPOINT).
# Bakes the settings into the image so they don't depend on the
# /etc/searxng volume, which keeps whatever settings.yml it was first given.
FROM searxng/searxng:latest

COPY settings.yml /usr/local/searxng/firecrawl/settings.yml
ENV SEARXNG_SETTINGS_PATH=/usr/local/searxng/firecrawl/settings.yml
