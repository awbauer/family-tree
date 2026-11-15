# Standards: GEDCOM X model, PROV-O provenance, GEDCOM 7 interchange

**Status:** proposal. Nothing here is built yet beyond what "Today" notes.

## Decision

| Role | Standard | How we use it |
|---|---|---|
| **Conceptual model** | [GEDCOM X](https://gedcomx.org/Specifications.html) (FamilySearch; the model behind the FamilySearch API) | The shape and vocabulary of what we store: persons, relationships, facts, names, sources, evidence, conclusions, attribution. Type URIs (`http://gedcomx.org/Birth`) instead of ad hoc strings. |
| **Provenance** | [W3C PROV-O](https://www.w3.org/TR/prov-o/) | Who or what produced each conclusion, from which sources, by which activity: edits, reviews, imports, research-agent runs, reverts. Exportable as JSON-LD. |
| **Interchange** | [GEDCOM 7](https://gedcom.io/specifications/FamilySearchGEDCOMv7.html), with a GEDCOM 5.5.1 fallback | Import and export. Extensions documented in `HEAD.SCHMA` with URIs. 5.5.1 export stays because Ancestry, where the tree started, still imports and exports 5.5.1 with no announced 7.0 date. |

Why this split: GEDCOM X has the best *conceptual* model (record personas vs conclusions, evidence references, analysis, attribution) but little adoption as a file format. GEDCOM 7 is what other software reads. PROV-O says what neither does: an auditable chain from source to conclusion, including AI agents acting for a person.

## Principles

1. **Records are evidence; the tree is conclusions.** What a record says is stored as a GEDCOM X *persona* (`Person` with `extracted: true`) attached to its `SourceDescription`. The tree's people are conclusions that point at personas through `EvidenceReference`. This is the Genealogical Proof Standard in data form, and it is what our "findings" really are.
2. **Every conclusion is attributed and has provenance.** GEDCOM X `Attribution` (contributor, modified, change message) on each conclusion, backed by a PROV-O activity for every change.
3. **Vocabulary by URI.** Fact types, name types, relationship types, confidence and source types use GEDCOM X URIs. Our additions get our own namespace (`https://family-tree.example/terms/…`, the template's placeholder) and the same URIs label GEDCOM 7 extension tags in `SCHMA`.
4. **Storage stays D1 + JSON per record.** We adopt GEDCOM X's *shape*, not its XML or JSON file format, as storage. A GEDCOM X JSON export is cheap once the shape matches.

## Mapping: today → GEDCOM X

| Today | GEDCOM X | Notes |
|---|---|---|
| `people` row | `Person` (conclusion) | `gender` → `Gender{type: …/Male}`; `living` stays derived |
| name `{given, surname, suffix, type}` | `Name{type, nameForms[{fullText, parts[{type: …/Given\|…/Surname\|…/Suffix, value}]}]}` | `type`: …/BirthName, …/MarriedName, …/AlsoKnownAs |
| event `{type, date, place, value, note}` | `Fact{type: http://gedcomx.org/<Type>, date{original, formal}, place{original, descriptionRef}, value, qualifiers}` | `fid` stays as the fact `id`. `formal` dates use GEDCOM X date format (`+1931-02-02`, `A+1890`, ranges) |
| `families` row | **`Relationship`s**: one `Couple` (spouses + its facts, e.g. Marriage) and one `ParentChild` per parent–child pair | GEDCOM X has no family object. GEDCOM 7 does (`FAM`), so families are rebuilt on export. This is the biggest change (Phase 4) |
| `sources` row | `SourceDescription{resourceType: …/Record\|…/Collection\|…/DigitalArtifact\|…/PhysicalArtifact, titles, citations, about (url), repository, componentOf}` | |
| citation `{source, page, url, text, accessed}` | `SourceReference{description, qualifiers}` + the cited `SourceDescription`'s `citations` | `page` → a citation detail. `text` → the extracted record's text |
| citation `quality` (0–3) | conclusion `confidence` (…/High, …/Medium, …/Low) **and** GEDCOM 7 `QUAY` on export | QUAY 3 → High, 2 → Medium, 1/0 → Low |
| citation `source_type` / `information` / `evidence` | extension properties on the `SourceReference` (`ft:sourceType`, `ft:information`, `ft:evidence`) | GEDCOM X has no Evidence Explained vocabulary; these are ours, URI-identified |
| `fact.review {status, by, at, note, evidence}` | `confidence` on the Fact + `Attribution{contributor, modified, changeMessage}` + `EvidenceReference`s + an `analysis` Document holding the reasoning | `verified`/`disputed` stays as our status (`ft:reviewStatus`); GEDCOM X has confidence only |
| research **finding** | a `SourceDescription` + an extracted persona of what the record says + an `EvidenceReference` from the conclusion person to that persona + an analysis Document | `kind` (conflict, correction…) and `resolution` stay as app workflow on top |
| `media_map` entries | `SourceDescription{resourceType: …/DigitalArtifact, mediaType, about: file}` referenced from the person's `media`; `type` → our `ft:mediaType` (GEDCOM `MEDI`) | main photo: an ordered list with the main photo first, plus `ft:primary` |
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

## GEDCOM 7 interchange

- **Export 7.0** (`HEAD.GEDC.VERS 7.0`), alongside 5.5.1:
  - Header and IDs: `HEAD.SCHMA` declares every extension tag with its URI; `EXID` carries our stable ids (people, `fid`s) so round trips keep identity.
  - Notes and sources: `SNOTE` for shared notes; `SOUR` + `PAGE` + `DATA.TEXT` + `QUAY`.
  - Dates and places: `DATE` with `PHRASE` for dates that don't parse; `PLAC` + `MAP`.
  - Media: `OBJE` with `FILE`, `FORM` + `MEDI` and `CROP`. GEDCOM 7 has no primary-photo flag that I found, so the main photo is linked first and also marked with a documented `_PRIM`-style extension.
  - Families: `FAM` rebuilt from Couple and ParentChild relationships.
- **Validation**: check exports with FamilySearch's GEDCOM 7 tools in CI ([gedcom.io/tools](https://gedcom.io/tools/)).
- **Import 7.0 and 5.5.1** into the GEDCOM X shape, so a new tree can come from FamilySearch (7.0) or Ancestry (5.5.1).
- **GEDCOM X JSON export** for FamilySearch API interop, cheap once the shape matches.

## Phases (each its own PR, each reversible)

0. **This doc**, plus a URI vocabulary file (`docs/design/vocabulary.md`) for our extensions.
1. **Provenance (PROV-O)**: no schema change.
   - A PROV view over `changes`, and research runs recording `used` sources.
   - `/api/prov`, plus a "provenance" tab on each fact showing the chain from record to conclusion.
   - Low risk, high value.
2. **GEDCOM 7 export**, then import, with `SCHMA` extensions and CI validation. 5.5.1 export kept.
3. **GEDCOM X shapes for facts, names, sources and evidence.**
   - Type URIs, formal dates, `SourceDescription` / `SourceReference`, and `confidence` + `Attribution` on conclusions.
   - Findings become personas + `EvidenceReference`s.
   - A one-time D1 migration with a dry run, a diff report, and D1 Time Travel as the undo.
4. **Families → relationships** (Couple, ParentChild).
   - Touches derive, scope, ops, graph, the UI and export. Done last, behind the export that proves round trips.

## Risks and open questions

- **GEDCOM X adoption is thin** outside FamilySearch, and its spec has been quiet for years. We take the model and vocabulary, not a dependency on tooling.
- **Phase 4 is invasive.** Relationships are cleaner (half-siblings, one-parent families, same-sex couples need no workarounds), but every view that thinks in families changes. Worth it only if we also want GEDCOM X/FamilySearch interop; otherwise families can stay internal and map to relationships at the edges.
- **Ancestry round trips stay 5.5.1.** GEDCOM 7-only features (`EXID`, `SNOTE`) degrade there.
- **Evidence Explained terms are not in any of the three standards.** They are a documented extension.
