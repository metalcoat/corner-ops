import type { Metadata } from "next";
import { headers } from "next/headers";
import CustomerOrder from "./customer-order";
import { customerPageMetadata, jsonLdScript, publicPage, restaurantJsonLd, type GeoPoint, type SeoMenuCategory } from "@/lib/customer-seo";
import { orderingMenuWithVariants } from "@/lib/ordering-menu-variants";
import { deliLocation } from "@/lib/deli-location";
import "./order.css";

export async function generateMetadata(): Promise<Metadata> {
  return customerPageMetadata(publicPage("/order"), (await headers()).get("host") || "");
}

// The menu changes a few times a day at most; search data doesn't need every request to hit the database.
const MENU_CACHE_MS = 5 * 60_000;
let cachedMenu: { at: number; menu: SeoMenuCategory[] } | null = null;

async function seoMenu(): Promise<SeoMenuCategory[] | null> {
  if (cachedMenu && Date.now() - cachedMenu.at < MENU_CACHE_MS) return cachedMenu.menu;
  try {
    const menu = await orderingMenuWithVariants("Corner Deli", "web");
    cachedMenu = { at: Date.now(), menu };
    return menu;
  } catch (error) {
    console.error("Menu for search data failed to load", error);
    return cachedMenu?.menu || null;
  }
}

async function storeGeo(): Promise<GeoPoint | null> {
  try { return await deliLocation(); } catch { return null; }
}

export default async function OrderPage() {
  const [menu, geo] = await Promise.all([seoMenu(), storeGeo()]);
  const sections = (menu || []).map((category) => ({ ...category, items: category.items.filter((item) => item.available) })).filter((category) => category.items.length);
  return (
    <>
      {/* schema.org data from the store's own settings and menu (escaped), so search results can show hours, phone, menu and the order link. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(restaurantJsonLd({ menu, geo })) }} />
      <CustomerOrder />
      {sections.length > 0 && (
        <noscript>
          <section className="seoMenu" aria-label="Corner Deli menu">
            <h2>Corner Deli menu</h2>
            {sections.map((category) => (
              <div key={category.id}>
                <h3>{category.displayName}</h3>
                <ul>
                  {category.items.map((item) => (
                    <li key={item.id}>{item.name}{item.basePriceCents > 0 ? ` — $${(item.basePriceCents / 100).toFixed(2)}` : ""}</li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        </noscript>
      )}
    </>
  );
}
