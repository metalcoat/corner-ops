import test from "node:test";
import assert from "node:assert/strict";
import {
  customerPageMetadata,
  customerRobots,
  customerSitemap,
  jsonLdScript,
  menuCuisines,
  pageIndexable,
  publicPage,
  publicSiteUrl,
  restaurantJsonLd,
  type SeoMenuCategory,
} from "../src/lib/customer-seo.js";

const production = { ALLOW_INDEXING: "true" };
const dev = {};

const menu: SeoMenuCategory[] = [
  { id: "p", displayName: "Pizza and Wings", parentId: null, presentationOnly: false, items: [
    { id: "pz", name: "Pizza", basePriceCents: 1000, available: true, variants: [
      { name: "Small", basePriceCents: 1000, available: true }, { name: "Large", basePriceCents: 1600, available: true }] },
    { id: "gone", name: "Sold Out Special", basePriceCents: 900, available: false },
  ] },
  { id: "salads", displayName: "Salads & Deli", parentId: null, presentationOnly: true, items: [] },
  { id: "bulk", displayName: "Bulk / Party Salads", parentId: "salads", presentationOnly: false, items: [
    { id: "ps", name: "Potato Salad", basePriceCents: 0, available: true, variants: Array.from({ length: 8 }, (_, i) => ({ name: `${i + 1} lb`, basePriceCents: 400 * (i + 1), available: true })) },
  ] },
  { id: "subs", displayName: "Subs/Wraps", parentId: null, presentationOnly: false, items: [
    { id: "blt", name: "BLT </script>", description: "Bacon, lettuce, tomato", basePriceCents: 650, available: true, imageUrl: "/api/ordering/media/abc" },
    { id: "free", name: "Free Cup", basePriceCents: 0, available: true },
  ] },
];

test("site URL comes from PUBLIC_SITE_URL with the public site as default", () => {
  assert.equal(publicSiteUrl({}), "https://ordercornerdeli.com");
  assert.equal(publicSiteUrl({ PUBLIC_SITE_URL: "https://example.test/ " }), "https://example.test");
});

test("indexing needs ALLOW_INDEXING=true and the public ordering host", () => {
  assert.equal(pageIndexable("ordercornerdeli.com", "/order", production), true);
  assert.equal(pageIndexable("ordercornerdeli.com", "/order", dev), false);
  assert.equal(pageIndexable("ordercornerdeli.com", "/order", { ALLOW_INDEXING: "1" }), false);
  for (const host of ["dev.ordercornerdeli.com", "192.168.1.237:3000", "ops.ordercornerdeli.com", "team.ordercornerdeli.com", "localhost"])
    assert.equal(pageIndexable(host, "/order", production), false, host);
  for (const path of ["/account", "/account/sign-in", "/track/abc", "/order/confirmation"])
    assert.equal(pageIndexable("ordercornerdeli.com", path, production), false, path);
});

test("robots.txt: dev disallows everything, production allows public pages and lists the sitemap", () => {
  assert.deepEqual(customerRobots("dev.ordercornerdeli.com", production), { rules: { userAgent: "*", disallow: "/" } });
  assert.deepEqual(customerRobots("ordercornerdeli.com", dev), { rules: { userAgent: "*", disallow: "/" } });
  const prod = customerRobots("ordercornerdeli.com", production) as { rules: { allow: string[]; disallow: string[] }; sitemap: string };
  assert.ok(prod.rules.allow.includes("/"));
  for (const path of ["/pos", "/employee", "/api/", "/account", "/order/confirmation", "/ops", "/admin", "/checkout"]) assert.ok(prod.rules.disallow.includes(path), path);
  assert.equal(prod.sitemap, "https://ordercornerdeli.com/sitemap.xml");
});

test("sitemap lists the public pages at the configured base", () => {
  const urls = customerSitemap({ PUBLIC_SITE_URL: "https://example.test" }).map((entry) => entry.url);
  assert.ok(urls.includes("https://example.test/order"));
  assert.ok(urls.includes("https://example.test/privacy"));
  assert.ok(!urls.some((url) => /account|track|confirmation/.test(url)));
});

test("page metadata: canonical, social tags, robots follow the indexing rule", () => {
  const prod = customerPageMetadata(publicPage("/order"), "ordercornerdeli.com", production);
  assert.equal(prod.alternates.canonical, "https://ordercornerdeli.com/order");
  assert.equal(prod.openGraph.url, "https://ordercornerdeli.com/order");
  assert.equal(prod.twitter.card, "summary");
  assert.deepEqual(prod.robots, { index: true, follow: true });
  assert.match(prod.title, /^Corner Deli \| Pizza, Wings & Subs in Ogdensburg, NY/);
  assert.deepEqual(customerPageMetadata(publicPage("/order"), "dev.ordercornerdeli.com", production).robots, { index: false, follow: false });
});

test("Restaurant JSON-LD carries address, phone, hours and the live menu", () => {
  const data = restaurantJsonLd({ env: dev, menu, geo: { latitude: 44.69, longitude: -75.48 } }) as any;
  assert.equal(data.name, "Corner Deli");
  assert.equal(data.telephone, "+1-315-393-2271");
  assert.equal(data.email, "bills@ordercornerdeli.com");
  assert.equal(data.address.streetAddress, "828 Morris St");
  assert.equal(data.address.postalCode, "13669");
  assert.equal(data.geo.latitude, 44.69);
  const hours = Object.fromEntries(data.openingHoursSpecification.map((day: any) => [day.dayOfWeek.split("/").pop(), `${day.opens}-${day.closes}`]));
  assert.equal(hours.Sunday, "10:30-21:30");
  assert.equal(hours.Thursday, "10:30-21:30");
  assert.equal(hours.Friday, "10:30-22:30");
  assert.equal(hours.Saturday, "10:30-22:30");
  assert.deepEqual(data.servesCuisine, ["Pizza", "Wings", "Subs", "Wraps", "Deli", "Salads", "American"]);
  const sections = data.hasMenu.hasMenuSection;
  assert.deepEqual(sections.map((section: any) => section.name), ["Pizza and Wings", "Bulk / Party Salads", "Subs/Wraps"]);
  assert.deepEqual(sections[0].hasMenuItem.map((item: any) => item.name), ["Pizza"]);
  assert.deepEqual(sections[0].hasMenuItem[0].offers.map((offer: any) => [offer.name, offer.price]), [["Small", "10.00"], ["Large", "16.00"]]);
  assert.equal(sections[1].hasMenuItem[0].offers["@type"], "AggregateOffer");
  assert.equal(sections[2].hasMenuItem.length, 1, "free items have no offer and are left out");
  assert.equal(sections[2].hasMenuItem[0].image, "https://ordercornerdeli.com/api/customer/media/abc");
  assert.equal(restaurantJsonLd({ env: dev }).geo, undefined);
  assert.equal(restaurantJsonLd({ env: dev }).hasMenu, "https://ordercornerdeli.com/order");
});

test("JSON-LD script text cannot close its script tag", () => {
  const text = jsonLdScript(restaurantJsonLd({ env: dev, menu }));
  assert.ok(!text.includes("</script>"));
  assert.equal(JSON.parse(text).hasMenu.hasMenuSection[2].hasMenuItem[0].name, "BLT </script>");
  assert.deepEqual(menuCuisines(null), ["Pizza", "Wings", "Subs", "Burgers", "Sandwiches", "Deli", "American"]);
});
