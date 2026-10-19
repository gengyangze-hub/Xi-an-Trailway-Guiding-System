#!/usr/bin/env python3
"""Local online-sync companion for the Xi'an Metro map.

The official Xi'an Metro line/station API does not allow cross-origin
browser requests, so this tiny server:
  1. serves the static app, and
  2. exposes /api/sync-network, which fetches the official line/station
     tree, merges it with the embedded coordinates, and returns the same
     network JSON shape used by the app.

Run:  python sync_server.py
Open: http://127.0.0.1:8765/
"""
from __future__ import annotations

import json
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
BASE_NETWORK_PATH = ROOT / "src" / "network.json"
SYNC_CACHE_PATH = ROOT / "network-sync.json"
OFFICIAL_API = "https://www.xianrail.com/pas-gateway-api/api-basicdata/lineStation/findLineAndStation"
OFFICIAL_ORIGIN = "https://www.xianrail.com"
CACHE_SECONDS = 45

_lock = threading.Lock()
_cached_payload: dict | None = None
_cached_at = 0.0


def normalize_station(name: str) -> str:
    """Make official/base punctuation variants comparable."""
    return (
        name.strip()
        .replace("（", "(")
        .replace("）", ")")
        .replace("、", "/")
        .replace("／", "/")
        .replace(" ", "")
    )


def fetch_official_tree() -> list[dict]:
    body = b"{}"
    req = urllib.request.Request(
        OFFICIAL_API,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "xian-metro-nav-sync/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        raw = resp.read().decode("utf-8-sig")
    data = json.loads(raw)
    if not isinstance(data, list) or not data:
        raise ValueError("official API returned no lines")
    return data


def base_coordinates() -> tuple[dict[str, tuple[float, float]], dict[str, dict]]:
    network = json.loads(BASE_NETWORK_PATH.read_text(encoding="utf-8"))
    coords: dict[str, tuple[float, float]] = {}
    lines = {str(line["id"]): line for line in network["lines"]}
    for line in network["lines"]:
        for station in line["stations"]:
            key = normalize_station(station["name"])
            coords.setdefault(key, (float(station["lon"]), float(station["lat"])))
    return coords, lines


def fill_missing_coordinates(
    names: list[str], coords: dict[str, tuple[float, float]]
) -> list[tuple[float, float]]:
    """Use known coordinates; interpolate/extrapolate new stations."""
    known: dict[int, tuple[float, float]] = {}
    for idx, name in enumerate(names):
        point = coords.get(normalize_station(name))
        if point:
            known[idx] = point
    if not known:
        return [(108.942, 34.258)] * len(names)

    result: list[tuple[float, float]] = []
    for idx in range(len(names)):
        if idx in known:
            result.append(known[idx])
            continue
        before = [i for i in known if i < idx]
        after = [i for i in known if i > idx]
        if before and after:
            a, b = max(before), min(after)
            ratio = (idx - a) / (b - a)
            pa, pb = known[a], known[b]
            result.append((pa[0] + (pb[0] - pa[0]) * ratio, pa[1] + (pb[1] - pa[1]) * ratio))
        elif before:
            a = before[-2] if len(before) > 1 else before[-1]
            b = before[-1]
            pa, pb = known[a], known[b]
            result.append((pb[0] + (pb[0] - pa[0]), pb[1] + (pb[1] - pa[1])))
        elif after:
            a = after[0]
            b = after[1] if len(after) > 1 else after[0]
            pa, pb = known[a], known[b]
            result.append((pa[0] - (pb[0] - pa[0]), pa[1] - (pb[1] - pa[1])))
        else:
            result.append(next(iter(known.values())))
    return result


def build_network() -> tuple[dict, str]:
    official = fetch_official_tree()
    coords, base_lines = base_coordinates()

    by_id = {str(item.get("value", "")).lstrip("0") or "0": item for item in official}
    line_order = [str(line["id"]) for line in json.loads(BASE_NETWORK_PATH.read_text(encoding="utf-8"))["lines"]]

    stations_by_name: dict[str, list[str]] = {}
    built_lines: list[dict] = []

    for line_id in line_order:
        source = by_id.get(line_id)
        if not source:
            continue
        base = base_lines.get(line_id, {})
        official_names = [str(c.get("label", "")).strip() for c in source.get("children", [])]
        if len(official_names) < 2:
            continue
        points = fill_missing_coordinates(official_names, coords)
        stations = []
        for name, (lon, lat) in zip(official_names, points):
            key = normalize_station(name)
            stations_by_name.setdefault(key, [])
            if base.get("name") and base["name"] not in stations_by_name[key]:
                stations_by_name[key].append(base["name"])
            stations.append({"name": name, "lon": round(lon, 6), "lat": round(lat, 6), "transfer": False})
        built_lines.append(
            {
                "id": line_id,
                "name": base.get("name") or str(source.get("label", "")).replace("地铁", ""),
                "short": base.get("short") or base.get("name") or f"{line_id}号线",
                "color": base.get("color") or "#64748b",
                "headway": base.get("headway") or 5,
                "loop": bool(base.get("loop", False)),
                "stations": stations,
                "path": [[s["lon"], s["lat"]] for s in stations],
            }
        )

    transfers: dict[str, list[str]] = {}
    for line in built_lines:
        for station in line["stations"]:
            key = normalize_station(station["name"])
            names = stations_by_name.get(key, [])
            if len(names) > 1:
                station["transfer"] = True
                transfers[station["name"]] = names

    if not built_lines:
        raise ValueError("no metro lines could be merged")

    unique_names = {normalize_station(s["name"]) for line in built_lines for s in line["stations"]}
    data = {
        "meta": {
            "city": "西安",
            "updated": date.today().isoformat(),
            "lineCount": len(built_lines),
            "stationCount": len(unique_names),
            "transferCount": len(transfers),
            "source": "西安地铁官网",
        },
        "lines": built_lines,
        "transfers": transfers,
    }
    return data, "online"


def current_payload(force: bool = False) -> dict:
    global _cached_payload, _cached_at
    now = time.time()
    with _lock:
        if not force and _cached_payload and now - _cached_at < CACHE_SECONDS:
            return _cached_payload
        data, source = build_network()
        payload = {"version": data["meta"]["updated"], "source": source, "data": data}
        SYNC_CACHE_PATH.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        _cached_payload = payload
        _cached_at = now
        return payload


class Handler(BaseHTTPRequestHandler):
    server_version = "XianMetroSync/1.0"

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("[sync] " + fmt % args + "\n")

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self) -> None:
        if urlparse(self.path).path == "/api/sync-network":
            self._sync()
        else:
            self._json(405, {"error": "method not allowed"})

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/sync-network":
            self._sync()
        elif path == "/api/health":
            self._json(200, {"ok": True, "api": OFFICIAL_API})
        else:
            self._static(path)

    def _sync(self) -> None:
        try:
            payload = current_payload(force=True)
            self._json(200, payload)
        except Exception as exc:  # noqa: BLE001 - surface fetch errors to the app
            self._json(502, {"error": str(exc), "source": "online"})

    def _static(self, path: str) -> None:
        relative = unquote(path).lstrip("/") or "index.html"
        target = (ROOT / relative).resolve()
        try:
            target.relative_to(ROOT)
        except ValueError:
            self.send_error(403)
            return
        if not target.is_file():
            self.send_error(404)
            return
        content_type = {
            ".html": "text/html; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".svg": "image/svg+xml",
        }.get(target.suffix.lower(), "application/octet-stream")
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"西安地铁线网同步服务已启动: http://127.0.0.1:{port}/")
    print("点击页面顶部「实时同步」即可从西安地铁官网拉取最新线路与站序。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
