# Which model each agent uses

Each agent runs on its own model, set in the Worker's dashboard variables:

- `AI_MODEL_<AGENT>`: which model the agent uses.
- `AI_EFFORT_<AGENT>`: how hard it reasons.
- `<AGENT>` is one of `RESEARCH`, `CHAT`, `QUALITY`, `STORIES`, `LIBRARY`, `RELATIVES`, `PROFILES`, `STORY_CHECKS`.
- `AI_MODEL` (all agents) and the older `AI_EFFORT`, `AI_CHAT_EFFORT` and `AI_CONTENT_EFFORT` still work as fallbacks.

The defaults, prices and context windows are in [`worker/agent/models.js`](../../worker/agent/models.js). This page explains the choices. It was written in November 2026; the Workers AI catalog changes every few months, so re-check before relying on it.

## Constraints

- **No AI Gateway credits needed by default.** Every default runs on Workers AI and is billed to the Workers plan. Anthropic and OpenAI models through AI Gateway are opt-in, per agent, and need gateway credits or a provider key stored on the gateway.
- **The page assistant uses Workers AI models.** Its history may contain excerpts from private files, so it uses its Workers AI default when a gateway-provider model is configured. It uses Gemma 4 through the Workers AI binding for visual transcription.
- **Zero data retention.** Every Workers AI model below is marked zero-data-retention, which matters because the tree includes living people. Gateway models follow their provider's API terms instead.
- **Tool calling is essential.** Every agent works through tools, so only models with function calling qualify.
- **The model must be in Pi's catalog.** Flue reads Pi's catalog to learn a model's context window, effort levels and prices. A model the catalog doesn't know still runs, but threshold compaction can't engage and effort settings are ignored. That rules out **Inkling 2 Small** (released 12 Nov 2026, $0.30/$1.00) until Pi is updated.
- **Retirements:** Workers AI retires these on **20 Nov 2026**, after which requests fail with `410 Gone`:
  - Kimi K2.6 and K2.7 Code (Kimi K2.6 was our previous default);
  - GLM-5.2 and GLM-5.3 Flash;
  - DeepSeek V4 Pro and V4 Flash (0731);
  - Nemotron 3 120B and Qwen3 30B.
- **Effort levels are per model.** Pi raises an unsupported level to the next one up. For example, our assistant's "low" effort on Kimi K2.6 actually ran at "high". Each default below uses a level the model really has.

## Candidates (Workers AI, function calling, not retiring)

| Model | Input / cached / output, $ per M tokens | Context | Effort levels | Notes |
|---|---|---|---|---|
| DeepSeek V4.1 Flash 1017 | 0.30 / 0.006 / 1.20 | 1M | off, high, max | Cloudflare's recommended frontier replacement. Cached input is almost free, which suits agent loops that re-send context. Vision. Paid plan; 20 requests/min by default. |
| GLM-5.3 | 1.40 / 0.26 / 4.40 | 1M | low, high, max | Cloudflare's other frontier recommendation, Z.ai's flagship. Strongest open model on long agentic benchmarks. About 5× DeepSeek's price. |
| Qwen 3.8 27B | 0.45 / 0.05 / 3.20 | 262k | low, medium, xhigh | Recommended "smaller" model. Vision, cached-input pricing. |
| Gemma 4 26B A4B | 0.10 / — / 0.30 | 256k | — | Cheapest capable option; available on the free plan. No effort levels in the catalog. |
| gpt-oss-120b | 0.35 / — / 0.75 | 128k | low, medium, high | Solid reasoning; smaller window, no caching discount. |
| GLM-4.7 Flash | 0.06 / — / 0.40 | 131k | — | Very cheap and fast; weaker at multi-step tool use. |
| Claude Sonnet 5.5 (gateway) | 2.00 / 0.20 / 10.00 | 1M | up to max | Best instruction-following and prose of the lot; needs gateway credits. |
| Claude Haiku 5.5 (gateway) | 0.10 / 0.01 / 0.50 | 1M | up to max | Cheap gateway option; price rises above 100k input tokens. |

## Per agent

| Agent | What it needs | Default | Effort | Why | Alternative |
|---|---|---|---|---|---|
| **Research** (`RESEARCH`) | Long tool loops (search, read pages), judging evidence, never inventing a record. Input-heavy: each step re-sends its context | DeepSeek V4.1 Flash | high | Frontier-tier reasoning at a third of Kimi's input price. Cached re-sent context costs $0.006/M instead of $0.16/M, so the run that cost about $4 on Kimi would cost well under $1. 1M window. | GLM-5.3 if research quality disappoints (about 5× the cost); Claude Sonnet 5.5 for the strictest sourcing |
| **Page assistant** (`CHAT`) | Exact edit ops (fact ids, family ids, valid JSON), reading the right record, knowing when to ask instead of guessing. Interactive, small context | DeepSeek V4.1 Flash | high | Drafting precise edits needs reasoning, and DeepSeek has no level between off and high. One reply costs a fraction of a cent. | `AI_EFFORT_CHAT=off` for faster replies; Qwen 3.8 27B at `low` for lighter reasoning |
| **Data quality review** (`QUALITY`) | Cross-checking many items against the tree, conservative judgment, structured decisions. No web. Up to 100 items | DeepSeek V4.1 Flash | high | Same strengths as research. A 100-item review re-reads many records, which the cache discount makes cheap. | GLM-5.3 for subtler judgment; Qwen 3.8 27B to save money |
| **Stories** (`STORIES`) | The best prose and the most faithful use of facts; low volume, highly visible | GLM-5.3 | high | The task where quality matters most and volume least. A story uses tens of thousands of tokens, so even the flagship costs about five cents. | Claude Sonnet 5.5 (`AI_MODEL_STORIES=anthropic/claude-sonnet-5-5`), likely the best writer, if you add gateway credits |
| **Stories librarian** (`LIBRARY`) | Audit every story against the records, minimal revisions, rank candidates, write briefs. No web. Re-reads many records | DeepSeek V4.1 Flash | high | The quality reviewer's model: the same cross-checking job, made cheap by the cache discount. The new stories it commissions run on the stories agent's own model. | GLM-5.3 if its revisions read poorly |
| **Sherlock, find relatives** (`RELATIVES`) | The researcher's job aimed at people not yet in the tree: long search-and-read loops, matching records to a family on two or more identifiers, never inventing a person. Input-heavy | DeepSeek V4.1 Flash | high | The researcher's model, for the same reasons: frontier reasoning with nearly free cached context. Its own variable, so it can move independently of research runs. | GLM-5.3 if it proposes weak matches; Claude Sonnet 5.5 for the strictest sourcing |
| **Profiles** (`PROFILES`, weekly job) | A short bio from facts given in the prompt, one tool call. Bulk and parallel (up to 50 per run) | Qwen 3.8 27B | low | Short, constrained writing that a smaller model does well. Staying off DeepSeek keeps the weekly burst away from the 20/min limit that research and chat share. | Gemma 4 26B (cheaper, free-plan); DeepSeek V4.1 Flash for better prose |
| **Story checks** (`STORY_CHECKS`, weekly job) | Compare a story with the current facts, say whether it is still right, minimal revision if not | Qwen 3.8 27B | medium | Mostly a comparison with an occasional small edit, which suits a mid-size model. Bulk, so the same rate-limit reasoning applies. | DeepSeek V4.1 Flash if it misses contradictions |

### What this is based on

These are judgments from:
- each model's published capabilities, prices and context windows;
- Cloudflare's own replacement recommendations;
- what each agent's job requires.

They are not based on running these agents on each model. The per-agent settings exist so that's easy to do: to compare, set `AI_MODEL_STORIES` to two models in turn and draft the same story. The `[turn]` lines in Workers Logs show each model call's tokens and cost.

## Budgets

Spend is priced per model and budgeted in dollars:

| Variable | Default | Covers |
|---|---|---|
| `AI_DAILY_BUDGET_USD` | 5 | All agent runs plus the weekly job, per day |
| `AI_CHAT_DAILY_BUDGET_USD` | 1 | The assistant's own allowance |
| `AGENT_MAX_RUN_USD` | 1 | Per run; past it, the run submits what it has |

A model missing from the table in `models.js` is priced cautiously, at Sonnet-like rates.
