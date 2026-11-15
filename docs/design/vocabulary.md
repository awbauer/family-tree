# Vocabulary: our extension terms

GEDCOM X and PROV-O cover most of what the app stores. These are the additions, in our namespace `ft:` = `https://family-tree.example/terms/`. That's the template's placeholder; a deployment may keep it, since nothing dereferences it. They appear as extension properties in GEDCOM X JSON and as terms in the PROV-O JSON-LD (`/api/prov`). See [standards.md](standards.md).

## Evidence analysis (on a source reference / citation)
*Evidence Explained* and the Genealogical Proof Standard; none of the three standards has these.

| Term | Values | Meaning |
|---|---|---|
| `ft:sourceType` | `original`, `derivative`, `authored` | What the source is: the record itself; an index, transcript or abstract; or a compiled work |
| `ft:information` | `primary`, `secondary`, `undetermined` | Whether the informant had first-hand knowledge, near the time |
| `ft:evidence` | `direct`, `indirect`, `negative` | How the source answers the question the fact asks |
| `ft:quality` | `0`–`3` | The GEDCOM certainty number, kept alongside GEDCOM X's `confidence` (3 → High, 2 → Medium, 1/0 → Low) |
| `ft:accessed` | date | When the source was viewed |

## Conclusions
| Term | Values | Meaning |
|---|---|---|
| `ft:reviewStatus` | `verified`, `disputed`, `unverified` | A reviewer's conclusion about one fact; the reviewer and time are the fact's `Attribution`, the reasoning an `analysis` Document |
| `ft:primary` | boolean | On a person's media reference: their main photo (also listed first) |
| `ft:mediaKind` | GEDCOM media types: `photo`, `tombstone`, `newspaper`, `manuscript`, … | What a photo or document shows |

## Research workflow
| Term | Meaning |
|---|---|
| `ft:Suggestion` | A proposal in the review queue (research or tree edit), attributed to its author |
| `ft:Finding` | A research finding: what a record says about a person, as a persona with an `EvidenceReference`, with `ft:findingKind` (`confirmed`, `correction`, `conflict`, `data-error`, `new-fact`, `new-person`) and `ft:resolution` |
| `ft:changedFacts` | On a PROV entity version: the facts (`e…`, `n…`) that version added, updated, cited or reviewed |
| `ft:onBehalfOf` | On an activity a software agent carried out for a person: that person. The same fact is stated in standard PROV as a `prov:qualifiedDelegation` on the agent (`prov:agent` = the person, `prov:hadActivity` = the activity) |
| `ft:via` | On an activity: where the change was drafted, e.g. a page-assistant chat and draft (`chat-…#3`). Editors only |

## Activities (PROV-O `prov:Activity` subtypes)
`ft:Edit`, `ft:Revert` (undo), `ft:Import`, `ft:Resolution` (a finding resolved by an edit), `ft:Decision` (a finding kept as is or reopened), `ft:StatusChange`, `ft:StoryRevision`, `ft:ResearchRun` (a cloud research agent run; the agent `prov:actedOnBehalfOf` the editor who started it; pages read are `prov:used`, as `ft:WebPage` / `ft:WebSearch`). An edit drafted by the page assistant and applied by an editor is an `ft:Edit` associated with the agent `agent:assistant`, delegated by that editor.
