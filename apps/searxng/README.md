# SearXNG for Firecrawl

A stock SearXNG image with settings that Firecrawl's search needs:

- `json` output turned on (Firecrawl requests `format=json`; without it SearXNG answers 403)
- the limiter turned off (only Firecrawl calls it, over Railway's private network)

## Railway

Point the SearXNG service at this repo with root directory `apps/searxng`.
It builds from the Dockerfile here and listens on port 8080.
Keep `SEARXNG_SECRET` set on the service; it supplies `server.secret_key`.
Firecrawl reaches it at `SEARXNG_ENDPOINT=http://<service>.railway.internal:8080`.
