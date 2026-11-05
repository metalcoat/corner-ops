// What search engines read about Corner Deli on the public ordering site:
// page title/description, canonical/Open Graph tags, schema.org Restaurant and
// Menu data (name, address, phone, hours, menu with prices), robots.txt and the
// sitemap, so "pizza Ogdensburg" / "deli Ogdensburg" searches can show the
// store with its hours and an order link. Keep the address, phone and hours
// identical to the Google Business Profile.
//
// Search engines may index only when ALLOW_INDEXING=true (production only) and
// the visitor is on the public ordering host. Everything else (dev, staging,
// the LAN address, ops/team hosts, staff pages) is noindex. PUBLIC_SITE_URL is
// the canonical/sitemap base (default https://ordercornerdeli.com).
import { GREETER_HOURS, WEEKDAYS } from "./greeter-hours";
import { isCustomerHost } from "./customer-domain-routing";

type Env = Record<string, string | undefined>;

export const DEFAULT_PUBLIC_SITE_URL = "https://ordercornerdeli.com";
export const STORE_NAME = "Corner Deli";
export const STORE_LEGAL_NAME = "Mike's Corner Deli, LLC";
export const STORE_PHONE = "+1-315-393-2271";
export const STORE_EMAIL = "bills@ordercornerdeli.com";
export const STORE_ADDRESS = { street: "828 Morris St", city: "Ogdensburg", region: "NY", postalCode: "13669", country: "US" };
export const STORE_LOGO_PATH = "/corner-deli-logo.png";

export const ORDER_PAGE_TITLE = "Corner Deli | Pizza, Wings & Subs in Ogdensburg, NY — Order Online";
export const ORDER_PAGE_DESCRIPTION =
  "Order Corner Deli online for pickup or delivery in Ogdensburg, NY: pizza, wings, subs, wraps, burgers, deli platters and catering. 828 Morris St, (315) 393-2271.";

/** Canonical base URL of the public ordering site, without a trailing slash. */
export function publicSiteUrl(env: Env = process.env): string {
  const configured = env.PUBLIC_SITE_URL?.trim().replace(/\/+$/, "");
  return configured || DEFAULT_PUBLIC_SITE_URL;
}

/** Only production sets ALLOW_INDEXING=true; anything else stays out of search. */
export function indexingAllowed(env: Env = process.env): boolean {
  return env.ALLOW_INDEXING?.trim().toLowerCase() === "true";
}

// Customer pages that are personal or transactional: never in search.
const PRIVATE_CUSTOMER_PATHS = ["/account", "/track", "/order/confirmation"];

function within(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Whether this host + path may be indexed. Staff, POS and employee pages never are (they never run on the customer host). */
export function pageIndexable(hostname: string, pathname: string, env: Env = process.env): boolean {
  const host = hostname.split(":")[0];
  return indexingAllowed(env) && isCustomerHost(host) && !PRIVATE_CUSTOMER_PATHS.some((prefix) => within(pathname, prefix));
}

export type SeoPage = { path: string; title: string; description: string };

/** The public pages search engines should know about (also the sitemap). */
export const PUBLIC_PAGES: (SeoPage & { changeFrequency: "daily" | "yearly"; priority: number })[] = [
  { path: "/order", title: ORDER_PAGE_TITLE, description: ORDER_PAGE_DESCRIPTION, changeFrequency: "daily", priority: 1 },
  {
    path: "/delivery-policy",
    title: "Delivery & Pickup Policy | Corner Deli",
    description: "Where and when Corner Deli delivers in Ogdensburg, NY, how payment works, and how pickup at 828 Morris St works.",
    changeFrequency: "yearly",
    priority: 0.3,
  },
  {
    path: "/refund-policy",
    title: "Refund & Cancellation Policy | Corner Deli",
    description: "Corner Deli's refund and cancellation policy for online, phone and in-store orders, and how to reach us with questions.",
    changeFrequency: "yearly",
    priority: 0.2,
  },
  {
    path: "/privacy",
    title: "Privacy Policy | Corner Deli",
    description: "How Corner Deli collects, uses and protects your information when you order online or by phone, including payment security.",
    changeFrequency: "yearly",
    priority: 0.2,
  },
  {
    path: "/terms",
    title: "Terms and Conditions | Corner Deli",
    description: "Terms for Corner Deli online ordering and the Corner Deli text message (SMS) program.",
    changeFrequency: "yearly",
    priority: 0.2,
  },
  {
    path: "/sms-help",
    title: "SMS Help | Corner Deli",
    description: "Help for Corner Deli text messages: how to opt out, get help, and contact the store.",
    changeFrequency: "yearly",
    priority: 0.1,
  },
];

export function publicPage(path: string): SeoPage {
  const page = PUBLIC_PAGES.find((candidate) => candidate.path === path);
  if (!page) throw new Error(`No SEO entry for ${path}`);
  return page;
}

/**
 * Next.js metadata for a public page: title, description, canonical, Open
 * Graph, Twitter card and robots. Structurally a Next `Metadata` object.
 */
export function customerPageMetadata(page: SeoPage, hostname: string, env: Env = process.env) {
  const base = publicSiteUrl(env);
  const url = `${base}${page.path}`;
  const image = { url: `${base}${STORE_LOGO_PATH}`, width: 512, height: 512, alt: `${STORE_NAME} logo` };
  const index = pageIndexable(hostname, page.path, env);
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: url },
    openGraph: { title: page.title, description: page.description, url, siteName: STORE_NAME, locale: "en_US", type: "website" as const, images: [image] },
    twitter: { card: "summary" as const, title: page.title, description: page.description, images: [image.url] },
    robots: index ? { index: true, follow: true } : { index: false, follow: false },
  };
}

/** robots.txt: production customer host allows the public pages; every other host disallows everything. */
export function customerRobots(hostname: string, env: Env = process.env) {
  const host = hostname.split(":")[0];
  if (!indexingAllowed(env) || !isCustomerHost(host)) return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/api/customer/media/"],
      disallow: [
        "/api/", "/account", "/track", "/order/confirmation", "/checkout", "/pos", "/employee", "/ops", "/admin",
        "/signin", "/forgot-password", "/reset-password", "/team", "/kiosk", "/setup", "/scan", "/display", "/deli-board",
      ],
    },
    sitemap: `${publicSiteUrl(env)}/sitemap.xml`,
    host: publicSiteUrl(env),
  };
}

export function customerSitemap(env: Env = process.env) {
  const base = publicSiteUrl(env);
  return PUBLIC_PAGES.map((page) => ({ url: `${base}${page.path}`, changeFrequency: page.changeFrequency, priority: page.priority }));
}

// Menu data shape the SEO builders need (a subset of the ordering menu).
export type SeoMenuCategory = {
  id: string;
  displayName: string;
  description?: string;
  parentId: string | null;
  presentationOnly: boolean;
  items: {
    id: string;
    name: string;
    description?: string;
    basePriceCents: number;
    available: boolean;
    imageUrl?: string | null;
    variants?: { name: string; basePriceCents: number; available: boolean; defaultVariant?: boolean }[];
  }[];
};

// servesCuisine comes from what the live menu actually has.
const CUISINE_RULES: [RegExp, string][] = [
  [/pizza/i, "Pizza"],
  [/wings?\b/i, "Wings"],
  [/\bsubs?\b/i, "Subs"],
  [/wraps?/i, "Wraps"],
  [/burgers?/i, "Burgers"],
  [/sandwich/i, "Sandwiches"],
  [/breakfast/i, "Breakfast"],
  [/deli/i, "Deli"],
  [/salad/i, "Salads"],
  [/italian/i, "Italian"],
  [/mexican/i, "Mexican"],
  [/fish|seafood/i, "Seafood"],
  [/dessert/i, "Desserts"],
];
const FALLBACK_CUISINES = ["Pizza", "Wings", "Subs", "Burgers", "Sandwiches", "Deli", "American"];

export function menuCuisines(menu: SeoMenuCategory[] | null): string[] {
  const names = (menu || []).filter((category) => category.items.some((item) => item.available)).map((category) => category.displayName);
  // Sections that only group others (e.g. "Salads & Deli") count when any child has items.
  for (const category of menu || [])
    if (category.presentationOnly && (menu || []).some((child) => child.parentId === category.id && child.items.some((item) => item.available)))
      names.push(category.displayName);
  const found = CUISINE_RULES.filter(([pattern]) => names.some((name) => pattern.test(name))).map(([, cuisine]) => cuisine);
  return found.length ? [...found, "American"] : FALLBACK_CUISINES;
}

const dollars = (cents: number) => (cents / 100).toFixed(2);

function itemOffers(item: SeoMenuCategory["items"][number]) {
  const variants = (item.variants || []).filter((variant) => variant.available && variant.basePriceCents > 0);
  // A few sizes (pizza, wings) list each; long lists (by-the-pound salads, dinner packages) show the range.
  if (variants.length > 1 && variants.length <= 6)
    return variants.map((variant) => ({ "@type": "Offer", name: variant.name, price: dollars(variant.basePriceCents), priceCurrency: "USD" }));
  if (variants.length > 6) {
    const prices = variants.map((variant) => variant.basePriceCents);
    return { "@type": "AggregateOffer", lowPrice: dollars(Math.min(...prices)), highPrice: dollars(Math.max(...prices)), offerCount: variants.length, priceCurrency: "USD" };
  }
  const cents = variants[0]?.basePriceCents || item.basePriceCents;
  return cents > 0 ? { "@type": "Offer", price: dollars(cents), priceCurrency: "USD" } : undefined;
}

/** schema.org Menu built from the live menu: one MenuSection per category with items, prices include NY sales tax. */
export function menuJsonLd(menu: SeoMenuCategory[], env: Env = process.env) {
  const base = publicSiteUrl(env);
  const sections = menu
    .map((category) => {
      const items = category.items
        .filter((item) => item.available)
        .flatMap((item) => {
          const offers = itemOffers(item);
          if (!offers) return [];
          return [{
            "@type": "MenuItem",
            name: item.name,
            ...(item.description?.trim() ? { description: item.description.trim() } : {}),
            ...(item.imageUrl ? { image: `${base}${item.imageUrl.replace("/api/ordering/media/", "/api/customer/media/")}` } : {}),
            offers,
          }];
        });
      return items.length ? { "@type": "MenuSection", name: category.displayName, ...(category.description?.trim() ? { description: category.description.trim() } : {}), hasMenuItem: items } : null;
    })
    .filter((section) => section !== null);
  return {
    "@type": "Menu",
    "@id": `${base}/order#menu`,
    name: `${STORE_NAME} Menu`,
    url: `${base}/order`,
    inLanguage: "en-US",
    hasMenuSection: sections,
  };
}

export type GeoPoint = { latitude: number; longitude: number };

export function restaurantJsonLd(options: { env?: Env; menu?: SeoMenuCategory[] | null; geo?: GeoPoint | null } = {}) {
  const env = options.env || process.env;
  const base = publicSiteUrl(env);
  const menu = options.menu?.length ? menuJsonLd(options.menu, env) : null;
  return {
    "@context": "https://schema.org",
    "@type": "Restaurant",
    "@id": `${base}/#restaurant`,
    name: STORE_NAME,
    legalName: STORE_LEGAL_NAME,
    url: base,
    telephone: STORE_PHONE,
    email: STORE_EMAIL,
    image: `${base}${STORE_LOGO_PATH}`,
    logo: `${base}${STORE_LOGO_PATH}`,
    servesCuisine: menuCuisines(options.menu || null),
    priceRange: "$",
    acceptsReservations: false,
    hasMenu: menu || `${base}/order`,
    address: {
      "@type": "PostalAddress",
      streetAddress: STORE_ADDRESS.street,
      addressLocality: STORE_ADDRESS.city,
      addressRegion: STORE_ADDRESS.region,
      postalCode: STORE_ADDRESS.postalCode,
      addressCountry: STORE_ADDRESS.country,
    },
    ...(options.geo ? { geo: { "@type": "GeoCoordinates", latitude: options.geo.latitude, longitude: options.geo.longitude } } : {}),
    areaServed: { "@type": "City", name: "Ogdensburg, NY" },
    openingHoursSpecification: GREETER_HOURS.flatMap((day, index) =>
      day ? [{ "@type": "OpeningHoursSpecification", dayOfWeek: `https://schema.org/${WEEKDAYS[index]}`, opens: day.opens, closes: day.closes }] : []),
    potentialAction: {
      "@type": "OrderAction",
      target: { "@type": "EntryPoint", urlTemplate: `${base}/order`, inLanguage: "en-US", actionPlatform: ["https://schema.org/DesktopWebPlatform", "https://schema.org/MobileWebPlatform"] },
      deliveryMethod: ["http://purl.org/goodrelations/v1#DeliveryModePickUp", "http://purl.org/goodrelations/v1#DeliveryModeOwnFleet"],
    },
  };
}

/** JSON for a <script type="application/ld+json">, safe against "</script>" in menu text. */
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
