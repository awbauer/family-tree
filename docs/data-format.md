# Data format: research.json and places.json

These files are the inputs to the **import** (`python3 tools/build.py`, then `tools/seed_app.py`). Keep your copies in the git-ignored `family-data/` folder, next to your `.ged` export. [`example/`](../example) has a working set for the fictional family; copy it and edit.

After [cutover](agents/operations.md#cutover-the-app-becomes-the-source-of-truth-one-time) the app is the source of truth and these files are no longer read. Research then happens in the app, or through suggestions and the review queue.

## research.json

### Site and tree shape (edit by hand)

| Key | What |
|---|---|
| `site` | `title`, `familyName`, `mark` (logo letter), `eyebrow`, `lede`. These are the header and home-page text. |
| `home_person` | The GEDCOM ID the site is centred on (the fan chart and relationship labels are relative to them). |
| `core_people` | You, your parents and your siblings: the people who sit above the branches. |
| `branches` | `[{key, root, label, tagline, color, intro, inLaw?}]`, one per grandparent line, rooted at that grandparent. `inLaw: true` marks a spouse's family. |
| `trees` | Optional. `[{id, name, definition: {branches: ["*"] or [keys], include: [ids]}}]`. These are separately shareable trees (yours, your spouse's…); the default is one tree with everyone. |
| `context` | Historical events shown on timelines: `{year, month, title, text, branches?, places?}`. |
| `place_rules` | `[{pattern, before, message}]` flags anachronistic place names (for example "Czechoslovakia" before 1918). |
| `methodology` | Text for the Research overview page. |

### Corrections to the export (edit by hand)

| Key | What |
|---|---|
| `gedcom` | Which `.ged` is the main tree when the folder has more than one. |
| `grafts` | Other GEDCOM files to attach to the main tree (a relative's export, for example). See `tools/graft.py`. |
| `edits` | Structural fixes applied on every build: merging duplicates, moving a child to the right parents. See `tools/edits.py`. |
| `duplicates` | `[{ids: [a, b], note}]` flags probable duplicates on both profiles without merging them. |
| `overrides` | Display-only fixes `{id: {sex, name: {given, surname}, living}}`. Prefer fixing the tree itself. |

### Research (written by `tools/merge_research.py`, not by hand)

| Key | What |
|---|---|
| `people_status` | `{id: {status: verified / partly-verified / unverified / disputed, note}}` |
| `findings` | `{person, kind: confirmed / correction / conflict / data-error / new-fact / new-person, field, claim, finding, confidence, sources: [{title, url, note}]}` |
| `stories` | `{slug, title, branch, era, people, body, sources}`. In `body`, paragraphs are separated by blank lines; `[[I123\|label]]` links a person, and `**bold**`, `*italic*` and `## heading` work. |
| `todo` | Open research tasks: `{person, task, where, priority: high / medium / low}` |
| `todo_done` | Closed to-dos with their `outcome`. |
| `research_log` | Every search tried, including the ones that found nothing, so nobody repeats them. |
| `media` | `{id: [{file, portrait?, caption, date, source}]}`. Files live in the R2 bucket (and in `family-data/media/` for local preview). |

Write research as a **batch** file (shape: [`example/batch-example.json`](../example/batch-example.json)), check it with `python3 tools/merge_research.py --check batch.json`, then merge it with `python3 tools/merge_research.py batch.json`. The merge checks that every person ID exists in your GEDCOM and that every finding has a citation. It is safe to re-run. The method behind it is in [agents/research-protocol.md](agents/research-protocol.md).

## places.json

The map groups the raw place strings from the GEDCOM into canonical places using regular expressions:

```json
{"places": [{"key": "leeds", "name": "Leeds, England", "lat": 53.80, "lng": -1.55, "match": ["leeds"]}]}
```

Matching is case-insensitive and the first match wins. The build lists every place that matched nothing, so you can add it.

After cutover, places live in the app as records that nest (country › city › street › building), with types, other and historical names, and links from facts (see "Places" in [design/edit-ops.md](design/edit-ops.md)). Migration 0015 turns this file's entries into records. It keeps their patterns and their order, and adds any changes made in the app since. After that this file is no longer read.

You add and change places on the **Places** page ("By place", "Not on the map"), or with **Edit this place** and **Add a place inside it** on a place's page. Agents use the `place.save`, `place.merge` and `place.delete` edit ops.
