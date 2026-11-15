// Helpers shared by the browse pages (home, branch, people, tree, map, timeline).
import { Link } from "react-router";
import { useData } from "../../data";
import { years } from "../../lib";
import { STATUS_LABEL } from "../../tree";
import { useBranchStyle } from "../../ui";
import type { Branch, Event, Person, Tree } from "../../types";

// Fields /api/tree carries that types.ts doesn't declare (yet).
export type BEvent = Event & { placeKey?: string; misfiled?: boolean };
export type BPerson = Omit<Person, "events"> & { direct?: boolean; generation?: number; events: BEvent[] };
export type BBranch = Branch & { inLaw?: boolean; intro?: string };
export interface Place { name: string; lat: number; lng: number }
export interface Issue { severity: string; person?: string; message: string }
export interface ContextRow { year: number; month?: number; title: string; text?: string }
export type BTree = Tree & { people: Record<string, BPerson>; issues?: Issue[]; places?: Record<string, Place> };

/** The tree with the extra fields the browse pages read. */
export function useBrowse() {
  const d = useData();
  return { ...d, D: d.D as BTree, people: d.people as BPerson[] };
}

/** A person card in the people grids. */
export function PCard({ p }: { p: BPerson }) {
  const bstyle = useBranchStyle();
  return (
    <Link className="p-card" to={`/person/${p.id}`} style={bstyle(p.branch)}>
      <div><div className="nm">{p.name}</div><div className="sub">{years(p) || "dates unknown"}{p.relation ? ` · ${p.relation}` : ""}</div></div>
      <span className={`badge st-${p.status}`} title={STATUS_LABEL[p.status || ""]} />
    </Link>
  );
}
