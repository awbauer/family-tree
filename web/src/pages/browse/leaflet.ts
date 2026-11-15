// Leaflet, loaded from cdnjs the first time the map is opened. Kept on window.L, so it is only ever loaded once.
declare global { interface Window { L?: any } }

let loading: Promise<any> | null = null;
export function loadLeaflet(): Promise<any> {
  if (window.L) return Promise.resolve(window.L);
  if (loading) return loading;
  loading = new Promise((res, rej) => {
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
    document.head.appendChild(css);
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
    s.onload = () => res(window.L);
    s.onerror = () => { loading = null; css.remove(); s.remove(); rej(new Error("Leaflet didn't load")); };
    document.head.appendChild(s);
  });
  return loading;
}
