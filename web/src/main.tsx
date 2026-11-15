// The site's entry point. Routes are hash-based (#/person/I12), so links from earlier versions keep working.
// Pages not yet ported to React are drawn by the legacy code through <LegacyRoute>.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createHashRouter, Outlet, RouterProvider, useLocation } from "react-router";
import "./styles.css";
import { DataProvider, useData } from "./data";
import { Shell } from "./Shell";
import { LegacyRoute, legacyFor } from "./LegacyRoute";
import { Stories } from "./pages/Stories";
import { Story } from "./pages/Story";
import { About } from "./pages/About";
import { NotFound } from "./pages/NotFound";

/** Any path the legacy code still draws goes there; anything else is "Not found". */
function Fallback() {
  const { D } = useData();
  const first = useLocation().pathname.split("/").filter(Boolean)[0] || "";
  return first === "" || legacyFor(D).routes.includes(first) ? <LegacyRoute /> : <NotFound />;
}

function Layout() {
  return <DataProvider><Shell><Outlet /></Shell></DataProvider>;
}

const router = createHashRouter([{
  element: <Layout />,
  children: [
    { path: "/stories", element: <Stories /> },
    { path: "/story/:slug", element: <Story /> },
    { path: "/about", element: <About /> },
    { path: "*", element: <Fallback /> },
  ],
}]);

createRoot(document.getElementById("root")!).render(<StrictMode><RouterProvider router={router} /></StrictMode>);
