// Small shared helpers and components for the React pages.
import { useEffect, type ReactNode } from "react";
import { Link } from "react-router";
import { useData } from "./data";
import type { Person } from "./types";
import { S } from "../../strings/index.ts";

export const norm = (s: string) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
export const isUnknown = (p?: Person | null) => !p || p.name === "Unknown";

export function years(p?: Person | null): string {
  if (!p) return "";
  const b = p.birth && p.birth.year, d = p.death && p.death.year;
  if (b && d) return `${b}–${d}`;
  if (b && p.living) return S.common.years.born(b);
  if (b) return `${b}–?`;
  if (d) return `?–${d}`;
  return p.living ? S.common.years.living : "";
}

export const branchColor = (key: string | undefined, known: Record<string, unknown>) => `var(--b-${key && key in known ? key : "other"})`;

/** The site's title and family name, from the tree's config. */
export function useSite() {
  const { D } = useData();
  return { ...S.common.site, ...(D.research.site || {}) };
}

/** Set the document title: "<page> · <site>". */
export function useTitle(page: string | null) {
  const site = useSite();
  useEffect(() => { document.title = page ? S.common.pageTitle(page, site.title) : site.title; }, [page, site.title]);
}

/** A link to a person's page (plain text when they aren't in the tree). */
export function PersonLink({ id, children }: { id: string; children?: ReactNode }) {
  const { D } = useData();
  const p = D.people[id];
  if (!p) return <>{children ?? S.common.unknown}</>;
  return <Link to={`/person/${id}`}>{children ?? p.name}</Link>;
}
