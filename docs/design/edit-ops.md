# Edit operations

Every change to the tree is a list of **ops**. The same format is used by direct edits (`POST /api/edit`), suggestions (`POST /api/proposals` with `kind: "edit"`), reverts (the inverse ops recorded in `changes`), and Ancestry hints (`tools/import_hints.py`). Ops apply in order, atomically; if any op fails, nothing is written.

IDs: people `I…`, families `F…`, sources `S…`, media `O…` (new ones get a `N`-prefixed ID, e.g. `NI3`, when the op leaves `id` out). Events and names carry a stable **fact ID** `fid` (`e1`, `e2`, … / `n1`, `n2`, … per person or family), assigned at import and never reused, so reviews, comments and citations can point at one fact.

| op | fields | notes |
|---|---|---|
| `person.create` | `id?`, `names: [{given, surname, suffix?, type?}]`, `sex?` (`M`/`F`/`U`), `events?: [event]` | |
| `person.update` | `id`, `set: {sex?, notes?}` | |
| `person.delete` | `id` | Only if they're in no family; unlink first |
| `person.merge` | `keep`, `drop` | Same rules as `tools/edits.py` merge_people; `drop` becomes an alias |
| `name.add` | `person`, `name: {given, surname, suffix?, type?}` | gets a new `fid` |
| `name.update` | `person`, `fid`, `set: {given?, surname?, suffix?, type?}` | |
| `name.remove` | `person`, `fid` | A person keeps at least one name |
| `event.add` | `entity: "person"\|"family"`, `id`, `event: {type, date?, place?, note?, value?, age?, citations?}` | gets a new `fid` |
| `event.update` | `entity`, `id`, `fid`, `set: {type?, date?, place?, note?, value?, age?}` | |
| `event.remove` | `entity`, `id`, `fid` | |
| `citation.add` | `entity`, `id`, `fid?`, `citation: {source, page?, url?, note?, text?}` | On an event when `fid` is given, otherwise on the person |
| `citation.remove` | `entity`, `id`, `fid?`, `index` | |
| `family.create` | `id?`, `husband?`, `wife?`, `children?: [ids]`, `events?: [event]` | |
| `family.set_spouse` | `family`, `role: "husband"\|"wife"`, `person` (or `null`) | |
| `family.swap_spouses` | `family` | |
| `family.add_child` / `family.remove_child` | `family`, `person` | Keeps `famc` in sync |
| `family.delete` | `family` | Unlinks everyone |
| `family.merge` | `keep`, `drop` | Spouses must match or be empty |
| `source.upsert` | `id?`, `data: {title, author?, publication?, url?, repository?}` | |
| `media.attach` | `person`, `file`, `caption?`, `portrait?`, `date?`, `source?` | `file` is an R2 key already uploaded |
| `media.detach` | `person`, `file` | |

Every op list comes with `reason` (required for direct edits) and optional `sources: [{title, url?, note?}]`.

Example, the kind of fix research produces:

```json
{"reason": "1950 census shows the roles reversed",
 "sources": [{"title": "1950 U.S. Census, ED 2-574, sheet 26", "url": "https://…"}],
 "ops": [{"op": "family.swap_spouses", "family": "F30"}]}
```
