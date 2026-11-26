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

Set these on the service to send some engines' searches through a proxy, so
search engines that block Railway's network answer again:

- `SEARXNG_PROXY_SERVER`: `host:port`, with or without `http://`
- `SEARXNG_PROXY_USERNAME` and `SEARXNG_PROXY_PASSWORD`
- `SEARXNG_PROXY_ENGINES` (optional): comma-separated engine names to send
  through the proxy. Defaults to `google,google cse,duckduckgo,qwant`. Other
  engines, such as Brave and Bing, connect directly. Brave refuses requests
  that come through the proxy.

On Railway they can reference another service's proxy settings, for example
`${{playwright-stealth.WEBSHARE_HOST}}:${{playwright-stealth.WEBSHARE_PORT}}`. With `SEARXNG_PROXY_SERVER` unset, SearXNG starts
without a proxy, as before. The start log names the proxied engines and the proxy host.
