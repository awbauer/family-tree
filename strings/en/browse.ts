// User-facing text: browse. See strings/index.ts for the conventions.
// Paragraphs with code spans are arrays: even items are plain text, odd items are code.

export const browse = {
  datesUnknown: "dates unknown",
  filters: { allBranches: "All branches", directOnly: "Direct ancestors only" },
  notFound: { title: "Not found", home: "Go home" },
  // ---------------------------------------------------------------- search (web/src/pages/Search.tsx)
  search: {
    title: "Search",
    label: "Search everything",
    placeholder: "A name, place, word or \"a phrase\"",
    hint: "Searches names (including spelling variants and names that sound alike), facts, places, notes, citations and transcriptions, stories, findings, to-dos and sources. Every word must appear in the same record; put a phrase in quotes.",
    variants: "Include names that sound alike or are spelled close",
    count: (n: number) => (n === 1 ? "1 record" : `${n} records`),
    none: "Nothing matches all of those words.",
    more: (n: number) => `Show ${n} more`,
    all: "All",
    kinds: { person: "People", story: "Stories", finding: "Findings", todo: "To-dos", source: "Sources" },
    kind: { person: "Person", story: "Story", finding: "Finding", todo: "To-do", source: "Source" },
    fields: { name: "name", fact: "fact", note: "note", citation: "citation", status: "research status", title: "title", text: "text", where: "where to look", outcome: "outcome" },
    how: { sounds: (w: string) => `sounds like: ${w}`, close: (w: string) => `spelled close: ${w}` },
    about: "about",
  },

  home: {
    stats: { people: "People", directAncestors: "Direct ancestors", generations: "Generations", earliestBirth: "Earliest birth", citations: "Citations" },
    explore: "Explore the tree",
    startWith: (name: string) => `Start with ${name}`,
    researchStatus: "Research status",
    fanCaption: (name: string) => `Five generations of ${name}’s ancestors. Grey = not yet identified.`,
    lines: { four: "Four grandparents, four lines", other: "Family lines", allPeople: "All people →" },
    branchCard: {
      line: (label: string) => `${label} line`,
      born: (place: string) => ` · born ${place}`,
      people: (n: number) => `${n} people in this branch →`,
    },
    stories: { title: "Stories", all: "All stories →" },
    solid: {
      title: "How solid is this tree?",
      text: "Each person is graded on whether independent records (not just other Ancestry trees) back up who they were.",
      problems: (n: number) => `${n} data problems flagged automatically →`,
    },
    questions: { title: "Top open questions", all: "Full research to-do list →", empty: "No research tasks recorded yet." },
  },

  branch: {
    line: (label: string) => `${label} line`,
    heading: (label: string) => `The ${label} line`,
    ancestorsOf: (name: string) => `Ancestors of ${name}`,
    allPeople: (n: number) => `All ${n} people`,
    surnames: "Surnames: ",
    stories: "Stories",
    direct: "Direct ancestors",
    others: "Other relatives",
  },

  people: {
    title: "People",
    filter: "Filter by name or place…",
    anyStatus: "Any status",
    count: (n: number) => `${n} people`,
    noSurname: "No surname",
    none: "No one matches.",
  },

  timeline: {
    title: "Timeline",
    direct: "Direct ancestors",
    everyone: "Everyone",
    hint: "Shaded rows are historical context.",
    married: " married ",
    decade: (d: number) => `${d}s`,
  },

  map: {
    title: "Map",
    heading: "Where the family lived",
    journeys: "Show journeys",
    loading: "Loading map…",
    failed: "The map library could not be loaded (offline?).",
    leafletFailed: "Leaflet didn't load",
    place: (people: number, events: number) => `${people} people · ${events} events`,
  },

  tree: {
    title: (name: string) => `Tree · ${name}`,
    unknownFather: "Unknown father",
    unknownMother: "Unknown mother",
    type: "Tree type",
    ancestors: "Ancestors",
    descendants: "Descendants",
    generations: "Generations",
    profile: "Profile →",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    fit: "Fit",
    hintMouse: "Click a person to re-centre · drag to pan · scroll to zoom",
    hintTouch: "Tap a person to re-centre · drag to pan · pinch to zoom",
  },

  fan: {
    unknown: "Unknown — research opportunity",
    label: (name: string) => `Fan chart of ${name}'s ancestors`,
  },

  stories: {
    title: "Stories",
    intro: "Narratives drawn from the records. Each story lists its sources; anything uncertain is said to be uncertain.",
    family: "Family",
    // "No stories written yet. Draft one above, or add them to <code>research.json</code> → <code>stories</code>."
    empty: { none: "No stories written yet.", aiAdd: " Draft one above, or add", add: " Add", rest: [" them to ", "research.json", " → ", "stories", "."] },
    draft: {
      summary: "Draft a story with AI",
      hint: "· written from the tree's records, sent to Suggestions for review",
      needPerson: "Add at least one person.",
      person: "Add a person…",
      add: "Add",
      who: "Who is it about? Add one or more people (living people can't be the subject).",
      remove: "Remove",
      instructions: "The angle, e.g. “her journey to England after the war” (optional)",
      length: "Length",
      lengths: { short: "Short (~300 words)", medium: "Medium (~700 words)", long: "Long (~1,200 words)" },
      submit: "Draft it",
    },
  },

  story: {
    people: "People: ",
    sources: "Sources",
    back: "← All stories",
    review: {
      summary: "Review with AI",
      hint: "· checks every claim against the records and suggests a revision",
      instructions: "Anything to change? e.g. “make it shorter”, “say more about the move” (optional)",
      start: "Start the review",
    },
  },

  about: {
    title: "How this site works",
    intro: ["The app (", "web/", ") contains no family data. A Cloudflare Worker serves the tree from a private D1 database, only to people let in by Cloudflare Access. The data is built from two private inputs:"],
    gedcom: {
      title: "1. The GEDCOM file",
      text: [" (", "*.ged", ") — the structure of the tree: people, families, events and the Ancestry citations. Keep editing the tree in Ancestry (or Gramps), then export a new GEDCOM and replace the file."],
    },
    research: {
      title: "2. The research file",
      text: [" (", "research.json", ") — everything Ancestry can’t hold well: verification status for each person, research findings with links to sources, corrections, written stories, historical context and the to-do list. It is keyed by the GEDCOM person IDs, so it survives re-exports."],
    },
    build: {
      text: ["Run ", "python3 tools/build.py", " to produce ", "build/seed.sql", ", then load it into the Cloudflare D1 database (see the README). The build also runs automatic checks (duplicates, impossible ages, people with two sets of parents, misfiled events, bad dates) which appear under "],
      link: "Research → Data problems",
      end: ".",
    },
    levels: {
      title: "Verification levels",
      // each follows its status badge
      verified: " independent records confirm identity and key dates. ",
      "partly-verified": " some facts confirmed. ",
      unverified: " only Ancestry tree data. ",
      disputed: " the evidence contradicts what the tree says.",
    },
    photos: {
      title: "Photos",
      text: (n: number) => [`The Ancestry export references ${n} photos and documents but doesn’t include the files. Download them, upload them to the R2 bucket (or `, "family-data/media/", " for local preview) and list them under ", "media", " in ", "research.json", ", e.g. ", '{"I123": [{"file": "photos/name.jpg", "portrait": true}]}', "."],
    },
  },
} as const;
