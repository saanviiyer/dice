// router.ts - the two places dice can be.
//
// Hash routing, on purpose. The same build has to work from three places: a
// static host with SPA rewrites, a static host without them, and the desktop
// shell, which loads index.html straight off disk over file://. A path-based
// router breaks in the last two. A hash never leaves the document, so one build
// serves all three.
//
// Paths are still honoured on the way in, so a link to /studio from anywhere
// lands in the right place and is then normalised to a hash.

export type Route = "home" | "studio";

export const ROUTES: Route[] = ["home", "studio"];

/** Which route a location refers to. Unknown routes fall back to home. */
export function routeFrom(loc: { pathname?: string; hash?: string }): Route {
  const raw = loc.hash || "";
  // Presence of a hash is what hands control to the hash, not its contents:
  // "#/" is an explicit request for home and has to beat a /studio path.
  if (raw.startsWith("#")) {
    const name = raw.replace(/^#\/?/, "").split(/[?#]/)[0];
    return name === "studio" ? "studio" : "home";
  }
  const path = (loc.pathname || "").replace(/\/+$/, "");
  if (/\/studio$/.test(path)) return "studio";
  return "home";
}

/** The href to link to a route with. Always a hash, so it works anywhere. */
export function hrefFor(route: Route): string {
  return route === "home" ? "#/" : `#/${route}`;
}

/** The document title for a route. */
export function titleFor(route: Route): string {
  return route === "studio" ? "dice studio" : "dice - produce music like a pro";
}
