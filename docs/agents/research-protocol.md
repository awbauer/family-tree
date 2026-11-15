# Research protocol

How an agent (or a person) researches the tree and records results. It's a lightweight version of the Genealogical Proof Standard: search reasonably widely, cite completely, weigh the evidence, resolve conflicts, and write down the conclusion.

## The loop

1. **Pick work.** Start from `family-data/research.json → todo`, highest `priority` first, unless the owner names a target. Note the `person` ID and the `branch`.
2. **Read what's known.** For that person, read:
   - the GEDCOM entry and their family (`build/family.json` is easier to read: `people[id]`, `families`)
   - `findings` where `person == id`
   - `research_log` where `person == id`, so you don't repeat a search someone already did
   - `todo_done`, `people_status[id]`, `duplicates`, `overrides`
3. **Search.** See "Sources" below. Record **every** search in the batch `log`, including ones that found nothing.
4. **Write a batch** at `family-data/batches/YYYY-MM-DD-<branch>-<agent>.json`. The shape is in [`example/batch-example.json`](../../example/batch-example.json) and at the top of `tools/merge_research.py`.
5. **Validate:** `python3 tools/merge_research.py --check family-data/batches/<file>.json`. Fix any errors.
6. **Merge** (or hand the batch to the coordinator): `python3 tools/merge_research.py family-data/batches/<file>.json`.
7. **Archive the evidence:** `python3 tools/archive_sources.py` saves a private copy of every newly cited source (images, PDFs, pages) to `family-data/evidence/`. Sites that block scripts are listed as `blocked`; tell the owner which ones to save by hand. Never work around a block.
8. **Rebuild and look:** `python3 tools/build.py && python3 tools/serve.py`. Check the person page.
9. **Report** to the owner what you found, what you didn't, and what needs a human (paywalled records, record orders, tree fixes). Loading into D1 is a separate step and needs the owner's OK (see [operations.md](operations.md)).

## Recording results

### Findings

One finding is one conclusion about one fact for one person.

| field | |
|---|---|
| `person` | GEDCOM ID. For `new-person`, the ID of the relative they attach to |
| `personName` | display name, for readability of the batch |
| `kind` | `confirmed`: a record supports what the tree says · `correction`: the tree is wrong; give the right value · `conflict`: records disagree and it's unresolved · `data-error`: a technical problem (misfiled event, duplicate, wrong person merged) · `new-fact`: something the tree lacks · `new-person`: a relative not in the tree |
| `field` | `birth`, `death`, `marriage`, `parents`, `immigration`, `residence`, `occupation`, `military`, `name`, `burial`, … |
| `claim` | what the tree currently says (or "nothing") |
| `finding` | what the evidence shows, specifically: names, dates, places, ages, addresses as written in the record |
| `confidence` | see below |
| `sources` | one or more `{title, url, note}`; see "Citations" |

### Confidence

- **high:** an original or image-backed record whose information comes from someone who was there (a marriage register signed by the couple, a draft card filled in by the man himself), matched to the person by **two or more independent identifiers** (age or birth date, parents' names, spouse, address, occupation), with nothing contradicting it.
- **medium:** a derivative source (index, transcription, abstract) or a single original record with only one solid identifier, or secondary information (a death certificate's birth date given by an informant).
- **low:** circumstantial or indirect evidence: the right name in the right place and time but nothing more, family lore, unsourced online trees.

Never mark a person `verified` on the strength of one derivative source. `verified` means the key vitals (birth, parents, marriage, death) are each supported by at least one original-record-quality source. `disputed` is for when good evidence contradicts the tree and the owner needs to decide.

### Identity: is this the same person?

Common names (and immigrant spellings) cause most errors. Before attaching a record to someone:

- Match on **two or more** identifiers besides the name. Name plus year alone isn't a match.
- Check for other people of the same name in the same place (search the census and city directory neighbourhood).
- Watch for spelling variants and transliteration (`Giuseppe` / `Joseph`, `Wojciech` / `Albert`, `Schmidt` / `Smith`, Latin forms in parish registers), and Americanized names after immigration.
- If it might be the same person but you can't prove it, write a `low` finding or just a log entry plus a to-do. Don't assert.

### Conflicts

When records disagree (two birth years, two fathers' names), write a `conflict` finding that lists each record and what it says, explains which you weigh more and why (original over derivative, earlier over later, an informant who was there over one who wasn't), and proposes what would settle it as a to-do.

### Citations

A citation must let a stranger find the same record again. Include as many as apply:

- **title:** jurisdiction, record type, date range, and the specific entry. E.g. "City of Leeds, marriage register, St Mary's parish, 1912, entry 214" or "U.S. WWII Draft Registration Cards, 1942, serial no. NNN", with the real number from the record you saw.
- **url:** a stable link to the image or entry (FamilySearch ARK `https://www.familysearch.org/ark:/…`, NARA catalog, archive page). Not a search-results URL if a record URL exists.
- **note:** where in the source (page, line, certificate, film number), whether you saw the **image** or only an **index/transcription**, and any discrepancy.

Do not paste whole copyrighted texts (modern obituaries, newspaper articles) into findings or stories. Summarize the facts and cite them.

### The research log

Every batch should have a `log` with one entry per search: `{person, question, searched, result, note}`. `searched` names the collection or site and the parameters (years, spelling variants, place). `result` is `found`, `nil` (searched and it isn't there) or `inconclusive` (couldn't access, too many candidates, illegible). This is how the next agent avoids repeating your work.

### To-dos

- Close a to-do you've resolved with `todo_done: [{person, task, outcome}]`. `task` is the exact text or a unique prefix of the existing to-do.
- Add new to-dos for leads you found but couldn't finish, especially records a human must order or view behind a login. Put the exact collection, certificate number or archive in `where`.

### Stories

Stories are short narratives built **only** from findings that are already cited. Link people with `[[ID|name]]`, put sources on the story, and mark uncertainty in the prose ("probably", "family tradition says"). No invented dialogue or invented detail for color.

## Sources

The sites to search are a **managed list**: Admin → Research sites in the app (owner only), seeded by migration `0010_research_sites.sql` with about 40 broadly useful, international resources. Each site has its coverage, record types, access (`open`, `free-account`, `subscription`, `institution`), source quality (`original-images`, `indexes`, `compiled`), whether it has an official API, and notes on how to search it well. Read it with `python3 tools/agent_api.py sites` (filter with `--type census`, `--access open`); the cloud agents get a summary in their first message and the full list from their `research_sites` tool.

How to use it:

- **Prefer listed sites**, and follow each site's notes. Where a site has a search URL template, fill in its `{given}`, `{surname}`, `{birth_year}` and `{place}` placeholders.
- **Prefer free, image-backed sources** you can actually read (`original-images`). An `indexes` site gives you an index or transcription: cite it as such (`medium` at most) and add a to-do for the image. A `compiled` site (user trees, directories, published genealogies) is a lead, not a source.
- **`subscription` and `institution` sites:** if the site has no credential (the cloud agents' `web_fetch` signs in automatically where the owner saved an API key or HTTP sign-in), log the search as `inconclusive` and add a to-do for the owner naming the exact collection and search. Never try to sign in through a form.
- **A nil result is only as good as the site's coverage.** Say which collection, place and years you searched.
- **Not on the list?** Use it if it's the right source, and suggest it to the owner in your report so it can be added.

If you can only reach the index, record it as an index (`medium` at most) and add a to-do for the image.

When you search the web, use the names of deceased ancestors as needed. Don't search for or record living people's personal details.

## What agents must not do

- Edit the GEDCOM or `research.json` findings by hand. Use a batch.
- Merge two people, delete people, or "clean up" duplicates. Record a `data-error` finding and let the owner act in the tree software.
- Mark something `confirmed` because an online family tree says so. Other people's trees are leads, not sources.
- Fill gaps with likely values (approximate birth years from typical marriage ages, etc.) without labeling them as estimates in the finding text.
