// The site's entry point. Routes are hash-based (#/person/I12), so links from earlier versions keep working.
import { StrictMode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { createHashRouter, Outlet, RouterProvider } from "react-router";
import "./styles.css";
import { DataProvider } from "./data";
import { Shell } from "./Shell";
import { Stories } from "./pages/Stories";
import { Story } from "./pages/Story";
import { About } from "./pages/About";
import { NotFound } from "./pages/NotFound";
import { Home } from "./pages/Home";
import { Branch } from "./pages/Branch";
import { People } from "./pages/People";
import { Timeline } from "./pages/Timeline";

// The larger pages load when first opened.
const lazy = (load: () => Promise<{ [k: string]: ComponentType }>, name: string) => async () => ({ Component: (await load())[name] });
const TreeChart = lazy(() => import("./pages/TreeChart"), "TreeChart");
const MapPage = lazy(() => import("./pages/MapPage"), "MapPage");
const Person = lazy(() => import("./pages/person/Person"), "Person");
const Research = lazy(() => import("./pages/research/Research"), "Research");
const Admin = lazy(() => import("./pages/admin/Admin"), "Admin");

function Layout() {
  return <DataProvider><Shell><Outlet /></Shell></DataProvider>;
}

const router = createHashRouter([{
  element: <Layout />,
  children: [
    { path: "/", element: <Home /> },
    { path: "/branch/:key", element: <Branch /> },
    { path: "/people", element: <People /> },
    { path: "/timeline", element: <Timeline /> },
    { path: "/map", lazy: MapPage },
    { path: "/tree", lazy: TreeChart },
    { path: "/tree/:id", lazy: TreeChart },
    { path: "/person/:id", lazy: Person },
    { path: "/research", lazy: Research },
    { path: "/research/:tab", lazy: Research },
    { path: "/admin", lazy: Admin },
    { path: "/admin/:tab", lazy: Admin },
    { path: "/stories", element: <Stories /> },
    { path: "/story/:slug", element: <Story /> },
    { path: "/about", element: <About /> },
    { path: "*", element: <NotFound /> },
  ],
}]);

createRoot(document.getElementById("root")!).render(<StrictMode><RouterProvider router={router} /></StrictMode>);
