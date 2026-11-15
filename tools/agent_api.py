#!/usr/bin/env python3
"""Work the family-tree to-do queue from the command line (for AI agents and scripts).

    python3 tools/agent_api.py queue                       # what's assigned to me, then what's unassigned
    python3 tools/agent_api.py claim 42                    # take to-do 42 (assigns it to me, status in_progress)
    python3 tools/agent_api.py submit batch.json --todo 42 --rationale "..."   # research for review; to-do -> needs_review
    python3 tools/agent_api.py suggest-edit ops.json --reason "..." [--todo 42]   # tree edits (docs/design/edit-ops.md)
    python3 tools/agent_api.py comment 42 "Searched X, nothing; trying Y next"
    python3 tools/agent_api.py release 42                  # give it back (unassign, status open)
    python3 tools/agent_api.py todos [--status active] [--assignee me]
    python3 tools/agent_api.py proposals [--status open]
    python3 tools/agent_api.py sites [--type census] [--access open] [--all] [--json]   # the research sites list

Configuration (environment variables; never put these in the repo):
  FT_URL                  the site, e.g. https://family.example.com   (default http://localhost:8787 for `npm run dev`)
  FT_TREE                 tree id (default: your first tree)
  CF_ACCESS_CLIENT_ID     Cloudflare Access service token for the agent (production)
  CF_ACCESS_CLIENT_SECRET
  FT_DEV_PRINCIPAL        local dev only (ALLOW_UNAUTHENTICATED): act as e.g. "agent:research"

Agents can claim, comment, move their own work to needs_review and submit suggestions. They can't close to-dos
or approve anything: an editor reviews every suggestion (docs/agents/research-protocol.md). The batch format is
the same one tools/merge_research.py validates (see example/batch-example.json); validate locally first with
`python3 tools/merge_research.py --check batch.json`.
"""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("FT_URL", "http://localhost:8787").rstrip("/")
TREE = os.environ.get("FT_TREE")


def call(method, path, body=None):
    sep = "&" if "?" in path else "?"
    url = f"{BASE}/api/{path}" + (f"{sep}tree={TREE}" if TREE else "")
    headers = {"Accept": "application/json", "User-Agent": "family-tree-agent/1"}
    if os.environ.get("CF_ACCESS_CLIENT_ID"):
        headers["CF-Access-Client-Id"] = os.environ["CF_ACCESS_CLIENT_ID"]
        headers["CF-Access-Client-Secret"] = os.environ.get("CF_ACCESS_CLIENT_SECRET", "")
    if os.environ.get("FT_DEV_PRINCIPAL"):
        headers["X-Dev-Principal"] = os.environ["FT_DEV_PRINCIPAL"]
    data = None
    if body is not None:
        if TREE:
            body = dict(body, tree=TREE)
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read())
        except Exception:  # noqa: BLE001
            err = {"error": f"HTTP {e.code}"}
        print(f"error {e.code}: {err.get('error')}", file=sys.stderr)
        for line in err.get("errors", []):
            print("  - " + line, file=sys.stderr)
        sys.exit(1)


def show(todos):
    for t in todos:
        print(f"#{t['id']:<4} {t['priority']:<6} {t['status']:<13} {t.get('assignee') or '-':<24} {t.get('person') or '-':<15} {t['task'][:90]}")


def opt(args, name, default=None):
    if name in args:
        i = args.index(name)
        return args[i + 1]
    return default


def main(argv):
    if not argv:
        sys.exit(__doc__)
    cmd, args = argv[0], argv[1:]
    if cmd == "queue":
        q = call("GET", "queue")
        print("Assigned to me:"); show(q["assigned"])
        print("\nAvailable (unassigned):"); show(q["available"])
    elif cmd == "todos":
        qs = "&".join(f"{k}={v}" for k, v in (("status", opt(args, "--status", "active")), ("assignee", opt(args, "--assignee"))) if v)
        show(call("GET", f"todos?{qs}")["todos"])
    elif cmd == "claim":
        t = call("POST", f"todos/{int(args[0])}/claim")["todo"]
        print(f"Claimed #{t['id']}: {t['task']}")
    elif cmd == "release":
        call("PATCH", f"todos/{int(args[0])}", {"assignee": None, "status": "open"})
        print(f"Released #{args[0]}")
    elif cmd == "comment":
        call("PATCH", f"todos/{int(args[0])}", {"comment": " ".join(args[1:])})
        print("Comment added")
    elif cmd == "submit":
        batch = json.loads(open(args[0]).read())
        body = {"kind": "research", "payload": batch, "rationale": opt(args, "--rationale")}
        if opt(args, "--todo"):
            body["todo_id"] = int(opt(args, "--todo"))
        p = call("POST", "proposals", body)["proposal"]
        print(f"Submitted suggestion #{p['id']} for review" + (f" (to-do #{p['todo_id']} is now needs_review)" if p.get("todo_id") else ""))
    elif cmd == "suggest-edit":
        doc = json.loads(open(args[0]).read())
        ops = doc["ops"] if isinstance(doc, dict) else doc
        reason = opt(args, "--reason") or (doc.get("reason") if isinstance(doc, dict) else None)
        if not reason:
            sys.exit("--reason is required: say what the evidence is")
        body = {"kind": "edit", "payload": {"ops": ops, "reason": reason, "sources": doc.get("sources") if isinstance(doc, dict) else None}, "rationale": reason}
        if opt(args, "--todo"):
            body["todo_id"] = int(opt(args, "--todo"))
        p = call("POST", "proposals", body)["proposal"]
        print(f"Submitted edit suggestion #{p['id']} ({len(ops)} ops) for review")
    elif cmd == "proposals":
        for p in call("GET", f"proposals?status={opt(args, '--status', 'open')}")["proposals"]:
            b = p["payload"]
            print(f"#{p['id']:<4} {p['status']:<9} {p['author']:<28} to-do {p.get('todo_id') or '-':<5} "
                  f"{len(b.get('findings', []))} findings, {len(b.get('log', []))} log, {len(b.get('todo', []))} new to-dos")
    elif cmd == "sites":
        # The owner's research sites (docs/agents/research-protocol.md → Sources): prefer these and follow their notes.
        # Credentials are never returned; "credential: yes" means the cloud agents can sign in there, not you.
        sites = call("GET", "research-sites")["sites"]
        if "--all" not in args:
            sites = [s for s in sites if s["enabled"]]
        if opt(args, "--type"):
            sites = [s for s in sites if opt(args, "--type") in s.get("record_types", [])]
        if opt(args, "--access"):
            sites = [s for s in sites if s["access"] == opt(args, "--access")]
        if "--json" in args:
            print(json.dumps(sites, indent=2, ensure_ascii=False))
            return
        for s in sites:
            flags = [s["access"], s["source_quality"]] + (["credential: yes"] if s.get("has_credential") else []) + ([] if s["enabled"] else ["disabled"])
            print(f"{s['name']}  <{s['url']}>  [{', '.join(flags)}]")
            if s.get("search_url"):
                print(f"    search: {s['search_url']}")
            print(f"    covers: {s['coverage']}")
            if s.get("record_types"):
                print(f"    records: {', '.join(s['record_types'])}")
            if s.get("agent_notes"):
                print(f"    notes: {s['agent_notes']}")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
