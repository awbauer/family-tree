#!/usr/bin/env python3
"""Local preview without Cloudflare.

    python3 tools/build.py && python3 tools/serve.py     # http://localhost:8000

Serves site/ as static files, /api/tree from build/family.json, and /media/<path> from
<data folder>/media/. Binds to 127.0.0.1 only — this is your private data.
"""
import argparse
import http.server
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--build", default=str(ROOT / "build"))
    ap.add_argument("--data", default=str(ROOT / "family-data" if (ROOT / "family-data").exists() else ROOT / "example"))
    a = ap.parse_args()
    bundle = Path(a.build) / "family.json"
    media_root = (Path(a.data) / "media").resolve()

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kw):
            super().__init__(*args, directory=str(ROOT / "site"), **kw)

        def do_GET(self):
            path = self.path.split("?")[0]
            if path == "/api/tree":
                if not bundle.exists():
                    return self.send_json({"error": f"{bundle} not found — run tools/build.py first"}, 404)
                body = bundle.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if path.startswith("/media/"):
                f = (media_root / path[len("/media/"):]).resolve()
                if media_root not in f.parents or not f.is_file():
                    return self.send_json({"error": "not found"}, 404)
                self.send_response(200)
                self.send_header("Content-Type", self.guess_type(str(f)))
                self.end_headers()
                self.wfile.write(f.read_bytes())
                return
            return super().do_GET()

        def send_json(self, obj, code):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

    print(f"Serving on http://localhost:{a.port}  (data: {bundle})")
    http.server.ThreadingHTTPServer(("127.0.0.1", a.port), H).serve_forever()


if __name__ == "__main__":
    main()
