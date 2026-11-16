// The shapes /api/tree and /api/me return, as far as the React pages use them. The tree is derived server-side
// (worker/derive.js) and scoped to the viewer (worker/scope.js).

export interface Event {
  fid?: string; type: string; date?: string; place?: string; value?: string; note?: string; dateDisplay?: string; sort?: number | null;
  citations?: { source?: string; page?: string; url?: string; title?: string; [k: string]: unknown }[];
  review?: { status?: string; by?: string; at?: string; note?: string; evidence?: any[] } | null;
  placeKey?: string; misfiled?: boolean; age?: string; address?: string;
}
export interface Person {
  id: string; name: string; given: string; surname: string; sex?: string;
  names: { fid?: string; given: string; surname: string; suffix?: string; type?: string }[];
  events: Event[]; famc: string[]; fams: string[];
  birth?: { year?: number | null; date?: string; place?: string } | null;
  death?: { year?: number | null; date?: string; place?: string } | null;
  living?: boolean; private?: boolean; branch?: string; relation?: string | null; status?: string; statusNote?: string;
  direct?: boolean; generation?: number | null; relationVia?: string | null; citations?: any[]; notes?: string[]; media?: any[];
}
export interface Family { id: string; husband?: string | null; wife?: string | null; children: string[]; events?: Event[] }
export interface Story { slug: string; title: string; era?: string; branch?: string; people?: string[]; body?: string; sources?: { title?: string; url?: string; note?: string }[] }
export interface Branch { key: string; label: string; color?: string; colorDark?: string; tagline?: string; root?: string; inLaw?: boolean; intro?: string }
export interface Research {
  site?: { title?: string; familyName?: string; mark?: string; eyebrow?: string; lede?: string };
  branches?: Branch[]; stories?: Story[]; findings?: any[]; todo?: any[]; context?: any[]; [k: string]: unknown;
}
export interface Account {
  principal: string; kind: string; displayName?: string; isOwner: boolean; personId?: string | null;
  trees: { id: string; name: string; role: string; view?: string | null }[]; ai?: boolean;
}
export interface Tree {
  generated: string; home: string; people: Record<string, Person>; families: Record<string, Family>;
  sources: Record<string, unknown>; media: Record<string, unknown>; aliases?: Record<string, string>;
  research: Research; me?: { principal: string; role: string; tree: string; isOwner: boolean } | null;
  scope?: { view: { media: boolean } };
  account?: Account | null; previewView?: string | null; issues?: any[]; places?: Record<string, any>;
}
