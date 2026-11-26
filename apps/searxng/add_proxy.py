"""Write a copy of settings.yml that sends some engines' searches through a proxy.

Reads SEARXNG_PROXY_SERVER (host:port, with or without http://),
SEARXNG_PROXY_USERNAME and SEARXNG_PROXY_PASSWORD, and writes the result to
the path given as the second argument. The credentials stay in the
environment and in that file only; nothing secret is kept in the repo.

Only the engines named in SEARXNG_PROXY_ENGINES (comma separated) use the
proxy; the rest connect directly. Brave answers from Railway's network but
refuses requests that come through the proxy, so by default only the engines
that block Railway go through it.
"""

import os
import sys
from urllib.parse import quote

import yaml

DEFAULT_ENGINES = "google,google cse,duckduckgo,qwant"

src, dst = sys.argv[1], sys.argv[2]

server = os.environ["SEARXNG_PROXY_SERVER"].strip()
if "://" not in server:
    server = "http://" + server
scheme, rest = server.split("://", 1)

user = os.environ.get("SEARXNG_PROXY_USERNAME", "").strip()
password = os.environ.get("SEARXNG_PROXY_PASSWORD", "").strip()
if user and "@" not in rest:
    auth = quote(user, safe="")
    if password:
        auth += ":" + quote(password, safe="")
    rest = auth + "@" + rest

names = os.environ.get("SEARXNG_PROXY_ENGINES", "").strip() or DEFAULT_ENGINES
proxied = [n.strip() for n in names.split(",") if n.strip()]

with open(src, encoding="utf-8") as f:
    settings = yaml.safe_load(f)

outgoing = settings.setdefault("outgoing", {})
outgoing.pop("proxies", None)
outgoing.setdefault("networks", {})["proxy"] = {"proxies": {"all://": [f"{scheme}://{rest}"]}}

engines = settings.setdefault("engines", [])
by_name = {e["name"]: e for e in engines}
for name in proxied:
    entry = by_name.get(name)
    if entry is None:
        entry = {"name": name}
        engines.append(entry)
    entry["network"] = "proxy"

with open(dst, "w", encoding="utf-8") as f:
    yaml.safe_dump(settings, f, sort_keys=False)

host = rest.rsplit("@", 1)[-1]
print(f"SearXNG sends {', '.join(proxied)} through the proxy at {scheme}://{host}", flush=True)
