import { describe, expect, it } from "vitest";
import { hrefFor, routeFrom, titleFor } from "./router";

describe("routeFrom", () => {
  it("reads the hash first", () => {
    expect(routeFrom({ hash: "#/studio" })).toBe("studio");
    expect(routeFrom({ hash: "#/" })).toBe("home");
    expect(routeFrom({ hash: "" })).toBe("home");
  });

  it("accepts a hash without the slash", () => {
    expect(routeFrom({ hash: "#studio" })).toBe("studio");
  });

  it("honours a path link, with or without a trailing slash", () => {
    expect(routeFrom({ pathname: "/studio" })).toBe("studio");
    expect(routeFrom({ pathname: "/studio/" })).toBe("studio");
    expect(routeFrom({ pathname: "/dice/studio" })).toBe("studio");
    expect(routeFrom({ pathname: "/" })).toBe("home");
  });

  it("lets the hash win over the path", () => {
    expect(routeFrom({ pathname: "/studio", hash: "#/" })).toBe("home");
  });

  it("falls back to home for anything it does not know", () => {
    expect(routeFrom({ hash: "#/mixer" })).toBe("home");
    expect(routeFrom({ pathname: "/nope" })).toBe("home");
    expect(routeFrom({})).toBe("home");
  });

  it("ignores a query string on the hash", () => {
    expect(routeFrom({ hash: "#/studio?from=email" })).toBe("studio");
  });

  it("handles the desktop shell's file:// location", () => {
    // Loaded straight off disk: the path ends in index.html and means home.
    expect(routeFrom({ pathname: "/Applications/dice.app/index.html", hash: "" })).toBe("home");
    expect(routeFrom({ pathname: "/Applications/dice.app/index.html", hash: "#/studio" })).toBe(
      "studio"
    );
  });
});

describe("hrefFor", () => {
  it("always produces a hash link", () => {
    expect(hrefFor("home")).toBe("#/");
    expect(hrefFor("studio")).toBe("#/studio");
  });

  it("round-trips with routeFrom", () => {
    for (const route of ["home", "studio"] as const) {
      expect(routeFrom({ hash: hrefFor(route) })).toBe(route);
    }
  });
});

describe("titleFor", () => {
  it("names the brand in both titles", () => {
    expect(titleFor("home")).toMatch(/^dice/);
    expect(titleFor("studio")).toMatch(/^dice/);
  });
});
