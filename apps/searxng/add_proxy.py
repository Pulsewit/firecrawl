"""Write a copy of settings.yml that sends SearXNG's searches through a proxy.

Reads SEARXNG_PROXY_SERVER (host:port, with or without http://),
SEARXNG_PROXY_USERNAME and SEARXNG_PROXY_PASSWORD, and writes the result to
the path given as the second argument. The credentials stay in the
environment and in that file only; nothing secret is kept in the repo.
"""

import os
import sys
from urllib.parse import quote

import yaml

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

with open(src, encoding="utf-8") as f:
    settings = yaml.safe_load(f)

settings.setdefault("outgoing", {})["proxies"] = {"all://": [f"{scheme}://{rest}"]}

with open(dst, "w", encoding="utf-8") as f:
    yaml.safe_dump(settings, f, sort_keys=False)

host = rest.rsplit("@", 1)[-1]
print(f"SearXNG searches go through the proxy at {scheme}://{host}", flush=True)
