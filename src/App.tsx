// App.tsx - which of the two dice surfaces to show.
//
// The site and the studio are one build (see lib/router.ts for why the routing
// is hash-based). The studio and its dependencies are code-split, so opening
// the front page does not download a DAW.

import { lazy, Suspense, useEffect, useState } from "react";
import Landing from "./Landing";
import { DiceMark } from "./BrandMarks";
import { routeFrom, titleFor, type Route } from "./lib/router";

const Studio = lazy(() => import("./Studio"));

export default function App() {
  const [route, setRoute] = useState<Route>(() => routeFrom(window.location));

  useEffect(() => {
    const onChange = () => setRoute(routeFrom(window.location));
    window.addEventListener("hashchange", onChange);
    window.addEventListener("popstate", onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
      window.removeEventListener("popstate", onChange);
    };
  }, []);

  useEffect(() => {
    document.title = titleFor(route);
    // A route change is a page change: start at the top, unless the link was to
    // an anchor within the page.
    if (!window.location.hash.includes("#", 1)) window.scrollTo(0, 0);
  }, [route]);

  if (route === "studio") {
    return (
      <Suspense
        fallback={
          <div className="flex min-h-full items-center justify-center gap-3 text-bone/70" role="status">
            <DiceMark size={28} />
            <span>loading the studio</span>
          </div>
        }
      >
        <Studio />
      </Suspense>
    );
  }
  return <Landing />;
}
