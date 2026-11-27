// A Leaflet map in a div: loads Leaflet (leaflet.ts), creates the map, keeps OpenStreetMap tiles in step with the
// light/dark theme (the Shell's `themechange` event), resizes with its box, and removes itself on unmount.
import { useEffect, useRef, useState, type RefObject } from "react";
import { loadLeaflet } from "./leaflet";

export const isDark = () => (document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark"; // strings-ok (a media query)
export const cssVar = (name: string, fallback = "#888") => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** A DOM element with text (Leaflet popups and tooltips take elements; text is never parsed as HTML). */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

export interface LeafletMap { L: any; map: any; layer: any }

export function useLeaflet(box: RefObject<HTMLDivElement | null>, options: Record<string, unknown> = {}) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [dark, setDark] = useState(isDark);
  const ref = useRef<LeafletMap | null>(null);

  useEffect(() => {
    const on = () => setDark(isDark());
    window.addEventListener("themechange", on);
    return () => window.removeEventListener("themechange", on);
  }, []);

  useEffect(() => {
    let gone = false, ro: ResizeObserver | null = null;
    loadLeaflet().then((L) => {
      if (gone || !box.current) return;
      const map = L.map(box.current, { worldCopyJump: true, ...options }).setView([45, -30], 3);
      ref.current = { L, map, layer: L.layerGroup().addTo(map) };
      ro = new ResizeObserver(() => { if (ref.current) map.invalidateSize(false); });
      ro.observe(box.current);
      setStatus("ready");
    }, () => { if (!gone) setStatus("error"); });
    return () => {
      gone = true;
      ro?.disconnect();
      // stop any zoom or pan first: removing a map mid-animation throws (_leaflet_pos) from Leaflet's pending frame
      if (ref.current) { const m = ref.current.map; ref.current = null; m.stop(); m.off(); m.remove(); }
      setStatus("loading");
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const M = ref.current;
    if (status !== "ready" || !M) return;
    const tiles = M.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap contributors", maxZoom: 19, className: dark ? "tiles-dark" : "tiles-light" }).addTo(M.map); // strings-ok (attribution)
    tiles.bringToBack();
    return () => { tiles.remove(); };
  }, [status, dark]);

  return { status, dark, M: status === "ready" ? ref.current : null };
}
