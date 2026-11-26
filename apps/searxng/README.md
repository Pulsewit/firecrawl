# SearXNG for Firecrawl

A stock SearXNG image with settings that Firecrawl's search needs:

- `json` output turned on (Firecrawl requests `format=json`; without it SearXNG answers 403)
- the limiter turned off (only Firecrawl calls it, over Railway's private network)

## Railway

Point the SearXNG service at this repo with root directory `apps/searxng`.
It builds from the Dockerfile here and listens on port 8080.
Keep `SEARXNG_SECRET` set on the service; it supplies `server.secret_key`.
Firecrawl reaches it at `SEARXNG_ENDPOINT=http://<service>.railway.internal:8080`.

## Proxy

Set these on the service to send SearXNG's searches through a proxy, so
search engines that block Railway's network answer again:

- `SEARXNG_PROXY_SERVER`: `host:port`, with or without `http://`
- `SEARXNG_PROXY_USERNAME` and `SEARXNG_PROXY_PASSWORD`

On Railway they can reference Firecrawl's own proxy settings, for example
`${{firecrawl.PROXY_SERVER}}`. With `SEARXNG_PROXY_SERVER` unset, SearXNG starts
without a proxy, as before. The start log names the proxy host it uses.
