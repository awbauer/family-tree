# Standards: GEDCOM X model and interchange, PROV-O provenance

**Status:** built.
- Phase 1, provenance: `worker/prov.js`, `/api/prov`.
- Phases 2–4: `worker/gedcomx.js` (lossless conversion, export and import) and `worker/storage.js` (GEDCOM X storage, with Couple/ParentChild relationships instead of families).
- An existing database moves over with **Admin → Data storage** (`POST /api/admin/storage`).

## Decision

| Role | Standard | How we use it |
|---|---|---|
| **Conceptual model** | [GEDCOM X](https://gedcomx.org/Specifications.html) (FamilySearch; the model behind the FamilySearch API) | The shape and vocabulary of what we store: persons, relationships, facts, names, sources, evidence, conclusions, attribution. Type URIs (`http://gedcomx.org/Birth`) instead of ad hoc strings. |
| **Provenance** | [W3C PROV-O](https://www.w3.org/TR/prov-o/) | Who or what produced each conclusion, from which sources, by which activity: edits, reviews, imports, research-agent runs, reverts. Exportable as JSON-LD. |
| **Interchange** | GEDCOM X too: its [JSON format](https://github.com/FamilySearch/gedcomx/blob/master/specifications/json-format-specification.md) (`application/x-gedcomx-v1+json`) | Export and import of the whole tree, or of what a person can see. It is also the FamilySearch API's format, so the same code can later push to or pull from FamilySearch. |
| *Legacy export* | GEDCOM 5.5.1 (already built) | Kept, unchanged in role, because it's the only format Ancestry imports and exports. Not a design target: no new features are designed around it. **No GEDCOM 7.** |

Why: GEDCOM X has the best model: record personas vs conclusions, evidence references, analysis and attribution. Using it for interchange too means one model end to end, with no lossy mapping to a second standard. PROV-O adds what GEDCOM X's `Attribution` doesn't cover: an auditable chain from source to conclusion, including AI agents acting for a person.

## Principles

1. **Records are evidence; the tree is conclusions.** What a record says is stored as a GEDCOM X *persona* (`Person` with `extracted: true`) attached to its `SourceDescription`. The tree's people are conclusions that point at personas through `EvidenceReference`. This is the Genealogical Proof Standard in data form, and it is what our "findings" really are.
2. **Every conclusion is attributed and has provenance.** GEDCOM X `Attribution` (contributor, modified, change message) on each conclusion, backed by a PROV-O activity for every change.
3. **Vocabulary by URI.** Fact types, name types, relationship types, confidence and source types use GEDCOM X URIs. Our additions get our own namespace (`https://family-tree.example/terms/…`, the template's placeholder), used as extension properties in GEDCOM X JSON.
4. **Storage stays D1 + JSON per record.** We adopt GEDCOM X's *shape*, not its XML or JSON file format, as storage. A GEDCOM X JSON export is cheap once the shape matches.

## Mapping: today → GEDCOM X

| Today | GEDCOM X | Notes |
|---|---|---|
| `people` row | `Person` (conclusion) | `gender` → `Gender{type: …/Male}`; `living` stays derived |
| name `{given, surname, suffix, type}` | `Name{type, nameForms[{fullText, parts[{type: …/Given\|…/Surname\|…/Suffix, value}]}]}` | `type`: …/BirthName, …/MarriedName, …/AlsoKnownAs |
| event `{type, date, place, value, note}` | `Fact{type: http://gedcomx.org/<Type>, date{original, formal}, place{original, descriptionRef}, value, qualifiers}` | `fid` stays as the fact `id`. `formal` dates use GEDCOM X date format (`+1931-02-02`, `A+1890`, ranges) |
| `families` row | **`Relationship`s**: one `Couple` (spouses + its facts, e.g. Marriage) and one `ParentChild` per parent–child pair | GEDCOM X has no family object. These relationships *are* the graph's edges (`worker/graph.js` already indexes parent, child and spouse links). Families are rebuilt only for the legacy 5.5.1 export. The biggest change (Phase 4) |
| `sources` row | `SourceDescription{resourceType: …/Record\|…/Collection\|…/DigitalArtifact\|…/PhysicalArtifact, titles, citations, about (url), repository, componentOf}` | |
| citation `{source, page, url, text, accessed}` | `SourceReference{description, qualifiers}` + the cited `SourceDescription`'s `citations` | `page` → a citation detail. `text` → the extracted record's text |
| citation `quality` (0–3) | conclusion `confidence` (…/High, …/Medium, …/Low) | 3 → High, 2 → Medium, 1/0 → Low; the number is kept as `ft:quality` (and written as `QUAY` only in the legacy 5.5.1 export) |
| citation `source_type` / `information` / `evidence` | extension properties on the `SourceReference` (`ft:sourceType`, `ft:information`, `ft:evidence`) | GEDCOM X has no Evidence Explained vocabulary; these are ours, URI-identified |
| `fact.review {status, by, at, note, evidence}` | `confidence` on the Fact + `Attribution{contributor, modified, changeMessage}` + `EvidenceReference`s + an `analysis` Document holding the reasoning | `verified`/`disputed` stays as our status (`ft:reviewStatus`); GEDCOM X has confidence only |
| research **finding** | a `SourceDescription` + an extracted persona of what the record says + an `EvidenceReference` from the conclusion person to that persona + an analysis Document | `kind` (conflict, correction…) and `resolution` stay as app workflow on top |
| `media_map` entries | `SourceDescription{resourceType: …/DigitalArtifact, mediaType, about: file}` referenced from the person's `media` | photo, headstone, newspaper… → `ft:mediaKind`; main photo: listed first, plus `ft:primary` |
| `notes` | `Note{text, attribution}` | |
| `places.json` gazetteer | `PlaceDescription{names, latitude, longitude, jurisdiction}` | Facts' `place.descriptionRef` points at these |
| AI profiles | not genealogical data: stays outside the model, with PROV-O provenance | |

## Provenance with PROV-O

The `changes` table is already an activity log. PROV-O names what it means:

| Ours | PROV-O |
|---|---|
| a change batch (`batch_id`) | `prov:Activity` (`ft:Edit`, `ft:Review`, `ft:Import`, `ft:Revert`, `ft:ResearchRun`), with `prov:startedAtTime` / `prov:endedAtTime` |
| a record's state after a change (`version_after`) | `prov:Entity` (`<person/I4/v7>`), `prov:wasGeneratedBy` the activity, `prov:wasRevisionOf` the previous version, `prov:specializationOf` the record |
| the editor | `prov:Agent` / `prov:Person`, `prov:wasAssociatedWith`; the change's reason → `prov:qualifiedAssociation` with a `prov:hadRole` and a note |
| sources cited for a change | `prov:used` by the activity; the conclusion `prov:wasDerivedFrom` the source (GPS: the conclusion's derivation) |
| an approved suggestion | the author's proposal is an Entity; approval is an Activity by the editor that `prov:used` it |
| a cloud research run | `prov:Activity` associated with `agent:cloud` (`prov:SoftwareAgent`) which `prov:actedOnBehalfOf` the editor who started it; every page it read is `prov:used`; its suggestion `prov:wasGeneratedBy` the run |
| undo | `prov:wasInvalidatedBy` on the undone versions; the restored version `prov:wasRevisionOf` the earlier one |
| the AI-written profile | `prov:wasGeneratedBy` a run, `prov:wasDerivedFrom` the fact versions it read |

Deliverables: a `prov` view of the existing log (no schema change), `GET /api/prov?id=…` as JSON-LD, and agent runs recording `used` URLs and the model as data, not only as log text.

## GEDCOM X interchange

- **Export** `GET /api/export.gedcomx` returns GEDCOM X JSON.
  - Persons, Couple and ParentChild relationships, facts with formal dates.
  - SourceDescriptions, extracted personas and EvidenceReferences.
  - Agents, plus Attribution on every conclusion.
  - Scoped like the other exports: exactly what the caller can see.
  - Our extensions are namespaced properties, which GEDCOM X allows and readers ignore.
- **Import** of GEDCOM X JSON into the same shape (FamilySearch, other GEDCOM X apps, or a round trip of our own export).
- **FamilySearch** later: its API speaks GEDCOM X, so reading or contributing records needs no second mapping.
- **Validation**: round-trip tests (export → import → identical), and checks against the GEDCOM X JSON spec's required fields and URIs in CI.
- **Legacy 5.5.1** export stays for Ancestry, generated from the same model (families rebuilt from relationships).

## How "family" works now

GEDCOM X has no family object, and storage has none either: families are relationship rows (`relationships`). The app's working model, which derive, scope, ops, the views and the 5.5.1 export use, still offers "families". These are rebuilt from the relationships on read, the way FamilySearch groups a couple with their children. `family.*` edit ops are translated into relationship changes on write.

The conversion is proved lossless:
- on the example data and on synthetic edge cases, in tests;
- on the owner's real tree, locally;
- and again by the upgrade itself, which refuses to write if any record would not convert back exactly.

The whole test suite also runs on GEDCOM X storage: `npm run test:gedcomx`.

## Phases (each its own PR, each reversible)

0. **This doc**, plus a URI vocabulary file (`docs/design/vocabulary.md`) for our extensions.
1. **Provenance (PROV-O)**: no schema change.
   - A PROV view over `changes`, and research runs recording `used` sources.
   - `/api/prov`, plus a "provenance" tab on each fact showing the chain from record to conclusion.
   - Low risk, high value.
2. **GEDCOM X JSON export**, then import, with round-trip tests. Today's model maps onto it at the edge, so this can ship before the storage changes.
3. **GEDCOM X shapes for facts, names, sources and evidence.**
   - Type URIs, formal dates, `SourceDescription` / `SourceReference`, and `confidence` + `Attribution` on conclusions.
   - Findings become personas + `EvidenceReference`s.
   - A one-time D1 migration with a dry run, a diff report, and D1 Time Travel as the undo.
4. **Families → relationships** (Couple, ParentChild).
   - Touches derive, scope, ops, graph, the UI and export. Done last, behind the export that proves round trips.

## Risks and open questions

- **GEDCOM X adoption is thin** outside FamilySearch, and its spec has been quiet for years. We take the model and vocabulary, not a dependency on tooling.
- **Phase 4 is invasive.** Relationships are cleaner (half-siblings, one-parent families, same-sex couples need no workarounds), and they are what the graph already traverses. But every view that thinks in families changes. With GEDCOM X as the interchange format, this is the direction to go; phase 2 maps families at the edge until then.
- **Few desktop apps read GEDCOM X.** Interchange with them (and with Ancestry) goes through the legacy 5.5.1 export, which loses personas, evidence references and attribution.
- **Evidence Explained terms are not in any of the three standards.** They are a documented extension.
