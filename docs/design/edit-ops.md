# Edit operations

Every change to the tree is a list of **ops**. The same format is used by direct edits (`POST /api/edit`), suggestions (`POST /api/proposals` with `kind: "edit"`), reverts (the inverse ops recorded in `changes`), and Ancestry hints (`tools/import_hints.py`). Ops apply in order, atomically; if any op fails, nothing is written.

IDs: people `I…`, families `F…`, sources `S…`, media `O…` (new ones get a `N`-prefixed ID, e.g. `NI3`, when the op leaves `id` out). Events and names carry a stable **fact ID** `fid` (`e1`, `e2`, … / `n1`, `n2`, … per person or family), assigned at import and never reused, so reviews, comments and citations can point at one fact.

| op | fields | notes |
|---|---|---|
| `person.create` | `id?`, `names: [{given, surname, suffix?, type?}]`, `sex?` (`M`/`F`/`U`), `events?: [event]` | |
| `person.update` | `id`, `set: {sex?, notes?, research_status?, status_note?}` | Person-level status is `unverified`, `partly-verified`, `verified`, or `disputed`. A null or blank `status_note` clears it. Omitted fields keep their values. Unknown fields in `set` are rejected. |
| `person.delete` | `id` | Only if they're in no family; unlink first |
| `person.merge` | `keep`, `drop` | Same rules as `tools/edits.py` merge_people; `drop` becomes an alias |
| `name.add` | `person`, `name: {given, surname, suffix?, type?}` | gets a new `fid` |
| `name.update` | `person`, `fid`, `set: {given?, surname?, suffix?, type?}` | |
| `name.remove` | `person`, `fid` | A person keeps at least one name |
| `event.add` | `entity: "person"\|"family"`, `id`, `event: {type, date?, place?, note?, value?, age?, citations?}` | gets a new `fid` |
| `event.update` | `entity`, `id`, `fid`, `set: {type?, date?, place?, note?, value?, age?}` | |
| `event.remove` | `entity`, `id`, `fid` | |
| `citation.add` | `entity`, `id`, `fid?`, `citation` (below) | On the fact when `fid` is given (an event `e…` or a name `n…`), otherwise on the person |
| `citation.remove` | `entity`, `id`, `fid?`, `index` | |
| `fact.review` | `entity`, `id`, `fid`, `status: "verified"\|"disputed"\|"unverified"`, `note`, `evidence?: [{index} or citation]`, `finding?` | A reviewer's conclusion about one fact (event or name). `evidence` points at citations already on the fact (`{index}`) or adds new ones, which are also cited on the fact. Verifying needs at least one cited source. Stored as `fact.review = {status, by, at, note, evidence, finding?}` |
| `family.create` | `id?`, `husband?`, `wife?`, `children?: [ids]`, `events?: [event]` | |
| `family.set_spouse` | `family`, `role: "husband"\|"wife"`, `person` (or `null`) | |
| `family.swap_spouses` | `family` | |
| `family.add_child` / `family.remove_child` | `family`, `person` | Keeps `famc` in sync |
| `family.delete` | `family` | Unlinks everyone |
| `family.merge` | `keep`, `drop` | Spouses must match or be empty |
| `source.upsert` | `id?`, `data: {title, type?, author?, publication?, url?, repository?, apid?, note?, text?}` | Creates the source, or updates the fields given (an empty value removes one). `type`: `original` record, `derivative` (index or transcript), compiled `tree`, `book`, `website`. `text` is a transcription. A title is required |
| `source.merge` | `keep`, `drop` | Re-points every use of `drop` to `keep`: citations on people, names, person and family events, fact-review evidence, and photos' `source`. Fills `keep`'s empty fields from `drop`, then removes `drop`. One batch, so one undo restores both |
| `source.delete` | `id` | Only when nothing cites it; merge a cited duplicate instead |
| `media.attach` | `person`, `file`, `caption?`, `type?`, `date?`, `place?`, `note?`, `source?`, `portrait?` | `file` is an R2 key already uploaded. `portrait: true` makes it the main photo |
| `media.update` | `person`, `file`, `set: {caption?, type?, date?, place?, note?, source?}` | An empty value removes the field. To link an existing report to a catalogued source, set `source` to its id on the report’s media entry. |
| `media.set_primary` | `person`, `file` | The person's main photo (their icon); exactly one per person. Exported as GEDCOM `_PRIM Y` |
| `media.detach` | `person`, `file` or `object` | `object` unlinks a media object imported from GEDCOM (`O…`) from the person; the object itself stays |

Every op list comes with `reason` (required for direct edits) and optional `sources: [{title, url?, note?}]`. A direct edit or an edit suggestion may also carry `resolves: [findingId]`. Those findings are marked resolved in the same change, so undoing the change reopens them. `POST /api/edit/preview` returns the before/after of every record an op list would touch, without saving; the app uses it to show diffs.

## Citations

Structured after GEDCOM's source citation and the evidence analysis of *Evidence Explained* / the Genealogical Proof Standard:

| field | meaning | GEDCOM export |
|---|---|---|
| `source` | a source record id (`S…`), when the source is catalogued | `SOUR @S…@` |
| `title`, `url` | for a source that isn't catalogued: what and where it is (`url` must be http(s)) | `SOUR <title>`, `_LINK` |
| `page` | where within the source: volume, page, entry, image | `PAGE` |
| `personal: true` | the person entering it knows this themselves: no document needed. The server sets `title` ("Personal knowledge"), `by` (who: the signed-in person, or the person an agent acts for; agents can't claim it) and `accessed` (the date); `note`, `text` and the analysis fields may be added. It counts as evidence for `fact.review` | `SOUR Personal knowledge` |
| `text` | a transcription of what the record says | `DATA.TEXT` |
| `accessed` | when it was viewed | `DATA.DATE` |
| `note`, `repository`, `apid` | free note; where the original is held; Ancestry record id | `NOTE`, `_APID` |
| `source_type` | `original` record, `derivative` (index, transcript, abstract), or `authored` work (a compiled tree, a book) | `_SRCTYPE` |
| `information` | `primary` (first-hand, near the time), `secondary`, or `undetermined` | `_INFO` |
| `evidence` | `direct`, `indirect` or `negative`, relative to the question the fact answers | `_EVID` |
| `quality` | GEDCOM certainty `0`–`3` (3 = direct and primary evidence) | `QUAY` |

Media types follow GEDCOM's `MEDI` list (`photo`, `tombstone`, `newspaper`, `manuscript`, `map`, `book`, `card`, …).

## Findings

A research finding (`findings` table) may name the fact it concerns (`fact: "e3"`) and carry `proposed_ops` that would fix the tree, so an editor can apply it in one step. Editors close a finding by fixing the tree with `resolves`, or with `PATCH /api/findings/:id {status: "resolved"|"dismissed"|"open", note, version}`. Dismissing ("keep the tree as is") needs a reason. The decision is stored as `finding.resolution = {status, by, at, note, batch?, proposal?}` and appears in the person's history.

Example, the kind of fix research produces:

```json
{"reason": "1950 census shows the roles reversed",
 "sources": [{"title": "1950 U.S. Census, ED 2-574, sheet 26", "url": "https://…"}],
 "ops": [{"op": "family.swap_spouses", "family": "F30"}]}
```
