---
name: research
description: Research a person or a to-do from family-data/research.json and record the results as a validated batch. Use when asked to research an ancestor, work the research to-do list, verify a fact, or find a record.
---

Follow `docs/agents/research-protocol.md` exactly. In short:

1. Identify the target: the to-do (highest priority first) or the person the owner named. Get the GEDCOM ID and branch.
2. Read what's already known: `build/family.json` for the person and family, plus `findings`, `research_log`, `todo_done` and `people_status` in `family-data/research.json`. Don't repeat logged searches.
3. Search real record sources. Read the actual record (image if possible). Log every search, including nil results.
4. Never invent a record, URL, certificate number, page or date. Paywalled or unreachable means an `inconclusive` log entry plus a to-do for the owner.
5. Write `family-data/batches/<YYYY-MM-DD>-<branch>-<agent>.json` (shape: `example/batch-example.json`).
6. `python3 tools/merge_research.py --check <batch>` until it passes, then merge, then `python3 tools/build.py`.
7. Report to the owner: findings with confidence, nil results, what needs a human. Don't load D1 or deploy; that's the `publish` skill, with the owner's OK.

Privacy: nothing from `family-data/` or `build/` goes into git, PRs, or any external service other than the record searches themselves. Living relatives are researched like anyone else; never record phone numbers, email addresses, or ID or account numbers.
