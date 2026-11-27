// Every piece of user-facing text in the app, in one place: labels, buttons, headings, help text, confirmations,
// empty states (the site, web/src) and the messages the Worker's API returns (worker/). Components and handlers read
// S.<area>.<key>; text that includes values is a function (S.queue.itemsLeftOut(3)), so a typo'd key or a missing
// argument fails the typecheck. Not here: agents' prompts (worker/agent, agents/), data-check messages that
// tools/build.py mirrors (worker/derive.js), and the tree's own data.
//
// The Worker imports this file too: keep it to erasable TypeScript (types and `as const`, no enums or namespaces) so
// Node runs it directly in the tests and wrangler bundles it as is. `npm run check:strings` finds text that should
// be here but isn't.
import { common } from "./en/common.ts";
import { browse } from "./en/browse.ts";
import { person } from "./en/person.ts";
import { research } from "./en/research.ts";
import { admin } from "./en/admin.ts";
import { api } from "./en/api.ts";
import { places } from "./en/places.ts";

export const S = { common, browse, person, research, admin, api, places } as const;
export type Strings = typeof S;
export { plural, list } from "./format.ts";
