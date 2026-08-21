"use client";
import { useEffect, useMemo, useState } from "react";

type Category = {
  id: string;
  name: string;
  display_name: string;
  sort_order: number;
  active: boolean;
};
type Item = {
  id: string;
  category_id: string;
  name: string;
  description: string;
  base_price_cents: number;
  available: boolean;
  active: boolean;
  sort_order: number;
};
type Variant = {
  id: string;
  item_id: string;
  name: string;
  base_price_cents: number;
  available: boolean;
  active: boolean;
  sort_order: number;
};
type Group = {
  id: string;
  name: string;
  prompt: string;
  min_selections: number;
  max_selections: number;
  active: boolean;
  sort_order: number;
};
type Option = {
  id: string;
  group_id: string;
  name: string;
  price_delta_cents: number;
  available: boolean;
  active: boolean;
  sort_order: number;
};
type Data = {
  categories: Category[];
  items: Item[];
  variants: Variant[];
  groups: Group[];
  options: Option[];
  links: { item_id: string; group_id: string; sort_order: number }[];
  localFields: { entity_type: string; entity_id: string; field_name: string }[];
};
type PrintItem = {
  id: string;
  effective_name: string;
  effective_print_name?: string | null;
};
type PrintVariant = {
  id: string;
  item_id: string;
  imported_name: string;
  effective_print_name: string;
};
type PrintGroup = {
  item_id: string;
  group_id: string;
  group_name: string;
  header_modifier: boolean | null;
  suppress_default_on_ticket: boolean | null;
};
type PrintOption = {
  item_id: string;
  group_id: string;
  id: string;
  imported_name: string;
  effective_print_name: string;
  print_order: number;
  print_section: string | null;
  suppress_when_default: boolean | null;
  print_only_when_changed: boolean | null;
  default_selected: boolean;
};
type Printing = {
  items: PrintItem[];
  variants: PrintVariant[];
  modifiers: PrintGroup[];
  modifierOptions: PrintOption[];
};
const dollars = (c: number) => (c / 100).toFixed(2),
  parseMoney = (v: string) => {
    if (!/^\d+(\.\d{1,2})?$/.test(v.trim()))
      throw new Error("Enter a valid non-negative dollar amount.");
    return Math.round(Number(v) * 100);
  };

export default function CatalogEditor({
  onChanged,
  printing,
  updatePrint,
  showPreview,
  preview,
}: {
  onChanged: () => void;
  printing: Printing;
  updatePrint: (
    type: string,
    id: string,
    field: string,
    value: unknown,
    reset?: boolean,
    itemId?: string,
  ) => Promise<void>;
  showPreview: (itemId: string) => Promise<void>;
  preview: string;
}) {
  const [data, setData] = useState<Data | null>(null),
    [selectedCategory, setSelectedCategory] = useState(""),
    [selectedItem, setSelectedItem] = useState(""),
    [attachGroupId, setAttachGroupId] = useState(""),
    [dragging, setDragging] = useState<{
      entity: "category" | "item";
      id: string;
    } | null>(null),
    [query, setQuery] = useState(""),
    [mode, setMode] = useState<"catalog" | "modifiers">("catalog"),
    [error, setError] = useState(""),
    [dirty, setDirty] = useState(false),
    [draft, setDraft] = useState<any>({});
  async function load() {
    const response = await fetch(
        "/api/ordering/settings/menu/catalog?business=Corner%20Deli",
        { cache: "no-store" },
      ),
      payload = await response.json();
    if (!response.ok) {
      setError(payload.error);
      return;
    }
    setData(payload);
    setSelectedCategory(
      (value) =>
        value || payload.categories.find((c: Category) => c.active)?.id || "",
    );
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const post = async (body: any) => {
    const response = await fetch(
        "/api/ordering/settings/menu/catalog?business=Corner%20Deli",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
      payload = await response.json();
    if (!response.ok) throw new Error(payload.error);
    if (payload.requiresConfirmation) {
      const names = [
        ...payload.dependencies.promotions,
        ...payload.dependencies.loyalty,
      ]
        .map((x: any) => x.name)
        .join(", ");
      if (!confirm(`This record is used by: ${names}. Archive it anyway?`))
        return null;
      return post({ ...body, confirmDependencies: true });
    }
    await load();
    onChanged();
    return payload;
  };
  const selectItem = (item: Item) => {
    if (dirty && !confirm("Discard unsaved item changes?")) return;
    setSelectedItem(item.id);
    setDraft({
      name: item.name,
      description: item.description,
      price: dollars(item.base_price_cents),
      categoryId: item.category_id,
      available: item.available,
      active: item.active,
      sortOrder: item.sort_order,
    });
    setDirty(false);
  };
  const matches = useMemo(() => {
    if (!data) return [];
    const q = query.toLowerCase().trim();
    if (!q) return data.items.filter((i) => i.category_id === selectedCategory);
    const optionItemIds = new Set(
      data.links
        .filter((l) =>
          data.options.some(
            (o) =>
              o.group_id === l.group_id && o.name.toLowerCase().includes(q),
          ),
        )
        .map((l) => l.item_id),
    );
    const variantItemIds = new Set(
      data.variants
        .filter((v) => v.name.toLowerCase().includes(q))
        .map((v) => v.item_id),
    );
    return data.items.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        data.categories
          .find((c) => c.id === i.category_id)
          ?.name.toLowerCase()
          .includes(q) ||
        optionItemIds.has(i.id) ||
        variantItemIds.has(i.id),
    );
  }, [data, query, selectedCategory]);
  if (!data) return <p>{error || "Loading catalog…"}</p>;
  const current = data.items.find((i) => i.id === selectedItem),
    variants = data.variants.filter((v) => v.item_id === selectedItem),
    linked = data.links
      .filter((l) => l.item_id === selectedItem)
      .map((l) => data.groups.find((g) => g.id === l.group_id))
      .filter(Boolean) as Group[];
  const edit = (key: string, value: any) => {
    setDraft((old: any) => ({ ...old, [key]: value }));
    setDirty(true);
  };
  const reorder = async (entity: "category" | "item", ids: string[]) => {
    await post({
      action: "reorder",
      entity,
      ids,
      categoryId: entity === "item" ? selectedCategory : undefined,
    });
  };
  const move = (entity: "category" | "item", id: string, delta: number) => {
    const ids = (entity === "category" ? data.categories : matches).map(
        (row) => row.id,
      ),
      index = ids.indexOf(id),
      target = index + delta;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void reorder(entity, ids);
  };
  const drop = (entity: "category" | "item", targetId: string) => {
    if (!dragging || dragging.entity !== entity || dragging.id === targetId)
      return;
    const ids = (entity === "category" ? data.categories : matches).map(
        (row) => row.id,
      ),
      from = ids.indexOf(dragging.id),
      to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    setDragging(null);
    void reorder(entity, ids);
  };
  async function saveItem() {
    try {
      await post({
        action: "update",
        entity: "item",
        id: selectedItem,
        patch: {
          name: draft.name,
          description: draft.description,
          basePriceCents: parseMoney(draft.price),
          categoryId: draft.categoryId,
          available: draft.available,
          active: draft.active,
          sortOrder: Number(draft.sortOrder),
        },
      });
      setDirty(false);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    }
  }
  const printItem = printing.items.find((row) => row.id === selectedItem),
    printVariants = printing.variants.filter(
      (row) => row.item_id === selectedItem,
    ),
    printGroups = printing.modifiers.filter(
      (row) => row.item_id === selectedItem,
    );
  const categoryItems = data.items.filter(
    (item) => item.category_id === selectedCategory,
  );
  return (
    <section className="catalogEditor">
      <div className="catalogTools">
        <button
          className={mode === "catalog" ? "selected" : ""}
          onClick={() => setMode("catalog")}
        >
          MENU DRILL-DOWN
        </button>
        <button
          className={mode === "modifiers" ? "selected" : ""}
          onClick={() => setMode("modifiers")}
        >
          SHARED MODIFIER LIBRARY
        </button>
        <input
          aria-label="Search menu"
          placeholder="Search items, variants, modifiers…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {error && <p role="alert">{error}</p>}
      {mode === "catalog" ? (
        <div className="threePane">
          <aside>
            <h2>Categories</h2>
            <button
              onClick={async () => {
                const name = prompt("New category name");
                if (name) await post({ action: "create_category", name });
              }}
            >
              + Category
            </button>
            <p className="reorderHint">Drag to set the POS display order.</p>
            {data.categories.map((c, index) => (
              <div
                key={c.id}
                className="categoryRow"
                draggable
                onDragStart={() =>
                  setDragging({ entity: "category", id: c.id })
                }
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => drop("category", c.id)}
              >
                <button
                  className={selectedCategory === c.id ? "selected" : ""}
                  onClick={() => setSelectedCategory(c.id)}
                >
                  ☰ {c.display_name || c.name}
                  {!c.active && <small>Archived</small>}
                </button>
                <button
                  aria-label={`Move ${c.name} up`}
                  disabled={index === 0}
                  onClick={() => move("category", c.id, -1)}
                >
                  ↑
                </button>
                <button
                  aria-label={`Move ${c.name} down`}
                  disabled={index === data.categories.length - 1}
                  onClick={() => move("category", c.id, 1)}
                >
                  ↓
                </button>
              </div>
            ))}
          </aside>
          <div className="itemBrowser">
            <div className="itemBrowserHeader">
              <div>
                <h2>Items</h2>
                <p>
                  {query
                    ? "Clear search to reorder items."
                    : "Drag tiles to match the ordering screen."}
                </p>
              </div>
              <button
                onClick={async () => {
                  const name = prompt("New item name");
                  if (name) {
                    const result = await post({
                      action: "create_item",
                      categoryId: selectedCategory,
                      name,
                      basePriceCents: 0,
                    });
                    if (result)
                      selectItem({
                        ...data.items[0],
                        id: result.id,
                        category_id: selectedCategory,
                        name,
                        description: "",
                        base_price_cents: 0,
                        available: true,
                        active: true,
                        sort_order: 0,
                      });
                  }
                }}
              >
                + Item
              </button>
            </div>
            <div className="itemTileGrid">
              {matches.map((i, index) => (
                <div
                  key={i.id}
                  className={`itemTile ${selectedItem === i.id ? "selected" : ""}`}
                  draggable={!query}
                  onDragStart={() => setDragging({ entity: "item", id: i.id })}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => drop("item", i.id)}
                >
                  <button
                    className="itemTileMain"
                    onClick={() => selectItem(i)}
                  >
                    <strong>{i.name}</strong>
                    <span>${dollars(i.base_price_cents)}</span>
                    {!i.active && <small>Archived</small>}
                  </button>
                  <div className="tileOrderControls">
                    <span aria-hidden="true">☰</span>
                    <button
                      aria-label={`Move ${i.name} up`}
                      disabled={Boolean(query) || index === 0}
                      onClick={() => move("item", i.id, -1)}
                    >
                      ↑
                    </button>
                    <button
                      aria-label={`Move ${i.name} down`}
                      disabled={
                        Boolean(query) || index === categoryItems.length - 1
                      }
                      onClick={() => move("item", i.id, 1)}
                    >
                      ↓
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <article>
            {current ? (
              <>
                <h2>Edit item</h2>
                {dirty && <strong className="dirty">Unsaved changes</strong>}
                <label>
                  Name
                  <input
                    value={draft.name}
                    onChange={(e) => edit("name", e.target.value)}
                  />
                </label>
                <label>
                  Description
                  <textarea
                    value={draft.description}
                    onChange={(e) => edit("description", e.target.value)}
                  />
                </label>
                <label>
                  Base price ($)
                  <input
                    inputMode="decimal"
                    value={draft.price}
                    onChange={(e) => edit("price", e.target.value)}
                  />
                </label>
                <label>
                  Kitchen print name
                  <input
                    key={current.id}
                    defaultValue={
                      printItem?.effective_print_name ??
                      printItem?.effective_name ??
                      current.name
                    }
                    onBlur={(e) =>
                      void updatePrint(
                        "item",
                        current.id,
                        "print_name",
                        e.currentTarget.value,
                      )
                    }
                  />
                </label>
                <label>
                  Category
                  <select
                    value={draft.categoryId}
                    onChange={(e) => edit("categoryId", e.target.value)}
                  >
                    {data.categories
                      .filter((c) => c.active)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.display_name || c.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={draft.available}
                    onChange={(e) => edit("available", e.target.checked)}
                  />{" "}
                  Available
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={draft.active}
                    onChange={(e) => edit("active", e.target.checked)}
                  />{" "}
                  Active
                </label>
                <div>
                  <button disabled={!dirty} onClick={() => void saveItem()}>
                    SAVE
                  </button>
                  <button onClick={() => void showPreview(current.id)}>
                    PRINT PREVIEW
                  </button>
                  <button
                    onClick={() =>
                      void post({
                        action: "duplicate_item",
                        entity: "item",
                        id: current.id,
                        name: `${current.name} Copy`,
                      })
                    }
                  >
                    Duplicate Item
                  </button>
                  <button
                    onClick={() =>
                      void post({
                        action: "archive",
                        entity: "item",
                        id: current.id,
                      })
                    }
                  >
                    Archive
                  </button>
                </div>
                {preview && (
                  <pre aria-label="Kitchen print preview">{preview}</pre>
                )}
                <h3>Variants</h3>
                {variants.map((v) => (
                  <VariantRow
                    key={v.id}
                    value={v}
                    printName={
                      printVariants.find((row) => row.id === v.id)
                        ?.effective_print_name || v.name
                    }
                    post={post}
                    updatePrint={updatePrint}
                  />
                ))}
                <button
                  onClick={async () => {
                    const name = prompt("Variant name");
                    if (name)
                      await post({
                        action: "create_variant",
                        itemId: current.id,
                        name,
                        basePriceCents: current.base_price_cents,
                      });
                  }}
                >
                  + Variant
                </button>
                <h3>Modifiers, prices, and ticket printing</h3>
                <div className="attachGroup">
                  <select
                    aria-label="Attach modifier group"
                    value={attachGroupId}
                    onChange={(e) => setAttachGroupId(e.target.value)}
                  >
                    <option value="">Choose shared modifier group…</option>
                    {data.groups
                      .filter(
                        (group) =>
                          !linked.some((row) => row.id === group.id) &&
                          group.active,
                      )
                      .map((group) => (
                        <option key={group.id} value={group.id}>
                          {group.name}
                        </option>
                      ))}
                  </select>
                  <button
                    disabled={!attachGroupId}
                    onClick={async () => {
                      await post({
                        action: "attach_group",
                        itemId: current.id,
                        groupId: attachGroupId,
                      });
                      setAttachGroupId("");
                    }}
                  >
                    Attach to item
                  </button>
                  <button
                    onClick={async () => {
                      const name = prompt("New modifier group for this item");
                      if (name)
                        await post({
                          action: "create_modifier_group",
                          itemId: current.id,
                          name,
                          minSelections: 0,
                          maxSelections: 1,
                        });
                    }}
                  >
                    + New group
                  </button>
                </div>
                {linked.map((group) => {
                  const printGroup = printGroups.find(
                    (row) => row.group_id === group.id,
                  );
                  return (
                    <details className="itemModifier" key={group.id}>
                      <summary>
                        {group.name} · {group.min_selections}–
                        {group.max_selections} choices
                      </summary>
                      <GroupEditor group={group} post={post} />
                      <button
                        onClick={() =>
                          void post({
                            action: "detach_group",
                            itemId: current.id,
                            groupId: group.id,
                          })
                        }
                      >
                        Remove from this item
                      </button>
                      <h4>Options and prices</h4>
                      {data.options
                        .filter((option) => option.group_id === group.id)
                        .map((option) => (
                          <OptionRow
                            key={option.id}
                            option={option}
                            post={post}
                          />
                        ))}
                      <button
                        onClick={async () => {
                          const name = prompt("New modifier option");
                          if (name)
                            await post({
                              action: "create_modifier_option",
                              groupId: group.id,
                              name,
                              priceDeltaCents: 0,
                            });
                        }}
                      >
                        + Option
                      </button>
                      {printGroup && (
                        <PrintGroupEditor
                          group={printGroup}
                          options={printing.modifierOptions.filter(
                            (row) =>
                              row.item_id === selectedItem &&
                              row.group_id === group.id,
                          )}
                          updatePrint={updatePrint}
                        />
                      )}
                    </details>
                  );
                })}
              </>
            ) : (
              <p>Select an item.</p>
            )}
          </article>
        </div>
      ) : (
        <div className="modifierGrid">
          <div>
            <h2>Modifier groups</h2>
            <button
              onClick={async () => {
                const name = prompt("New modifier group name");
                if (name)
                  await post({
                    action: "create_modifier_group",
                    name,
                    minSelections: 0,
                    maxSelections: 1,
                  });
              }}
            >
              + Group
            </button>
            {data.groups.map((g) => (
              <details key={g.id}>
                <summary>
                  {g.name} · {g.min_selections}–{g.max_selections}
                </summary>
                <GroupEditor group={g} post={post} />
                <h3>Options</h3>
                {data.options
                  .filter((o) => o.group_id === g.id)
                  .map((o) => (
                    <OptionRow key={o.id} option={o} post={post} />
                  ))}
                <button
                  onClick={async () => {
                    const name = prompt("New option name");
                    if (name)
                      await post({
                        action: "create_modifier_option",
                        groupId: g.id,
                        name,
                        priceDeltaCents: 0,
                      });
                  }}
                >
                  + Option
                </button>
              </details>
            ))}
          </div>
        </div>
      )}
      <style jsx>{`
        .catalogTools {
          display: flex;
          gap: 8px;
          margin: 12px 0;
        }
        .catalogTools input {
          flex: 1;
        }
        .threePane {
          display: grid;
          grid-template-columns: 220px minmax(420px, 1.35fr) minmax(360px, 1fr);
          gap: 12px;
        }
        .threePane > aside,
        .threePane > div,
        .threePane > article,
        .modifierGrid > div {
          background: #fff;
          padding: 12px;
          border-radius: 10px;
          min-height: 520px;
        }
        .threePane aside > button {
          display: flex;
          width: 100%;
          justify-content: space-between;
          text-align: left;
          margin: 4px 0;
        }
        .reorderHint,
        .itemBrowserHeader p {
          color: #4d5f52;
          font-size: 0.82rem;
          margin: 4px 0 8px;
        }
        .categoryRow {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 34px 34px;
          gap: 3px;
          margin: 4px 0;
          cursor: grab;
        }
        .categoryRow > button:first-child {
          display: flex;
          justify-content: space-between;
          min-width: 0;
          text-align: left;
        }
        .categoryRow > button:not(:first-child) {
          padding: 4px;
        }
        .itemBrowserHeader {
          display: flex;
          justify-content: space-between;
          align-items: start;
          gap: 10px;
        }
        .itemBrowserHeader h2 {
          margin-bottom: 0;
        }
        .itemTileGrid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(145px, 1fr));
          gap: 9px;
        }
        .itemTile {
          display: grid;
          grid-template-rows: minmax(92px, 1fr) 36px;
          overflow: hidden;
          border: 2px solid #cad5cc;
          border-radius: 10px;
          background: #f7faf7;
          cursor: grab;
        }
        .itemTile.selected {
          border-color: #23643c;
          box-shadow: 0 0 0 2px #b9dcc4;
        }
        .itemTileMain {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          justify-content: space-between;
          width: 100%;
          padding: 10px;
          border: 0;
          border-radius: 0;
          text-align: left;
        }
        .itemTileMain strong {
          font-size: 1rem;
        }
        .itemTileMain span {
          color: #34513e;
          font-weight: 800;
        }
        .tileOrderControls {
          display: grid;
          grid-template-columns: 1fr 38px 38px;
          align-items: center;
          border-top: 1px solid #cad5cc;
        }
        .tileOrderControls span {
          padding-left: 10px;
          color: #52665a;
        }
        .tileOrderControls button {
          min-height: 36px;
          padding: 3px;
          border-radius: 0;
        }
        .threePane small {
          display: block;
        }
        .threePane article {
          display: block;
        }
        .threePane article label {
          margin: 9px 0;
        }
        .threePane article input:not([type="checkbox"]),
        .threePane article textarea,
        .threePane article select {
          width: 100%;
        }
        .dirty {
          color: #9b4700;
        }
        .attachGroup {
          display: grid;
          grid-template-columns: 1fr auto auto;
          gap: 7px;
        }
        .itemModifier {
          border: 1px solid #b9c8bd;
          background: #f8fbf8;
        }
        .itemModifier > button {
          margin: 6px 6px 6px 0;
        }
        .itemModifier :global(.row) {
          display: grid;
          grid-template-columns: 2fr 1fr 1fr auto;
          gap: 7px;
          align-items: end;
        }
        .itemModifier :global(.row input) {
          width: 100%;
        }
        details {
          background: #fff;
          padding: 12px;
          margin: 8px 0;
          border-radius: 9px;
        }
        summary {
          font-weight: 800;
          cursor: pointer;
        }
        .variantRow {
          display: grid;
          grid-template-columns: 2fr 1fr 2fr auto auto;
          gap: 7px;
          margin: 7px 0;
        }
        .printGroup {
          border: 1px solid #d9dfda;
        }
        .printOption {
          display: grid;
          grid-template-columns: 1fr 2fr 80px 1fr auto auto;
          gap: 7px;
          align-items: center;
          padding: 7px 0;
          border-top: 1px solid #e4e7e4;
        }
        .printOption label {
          margin: 0 !important;
        }
        pre {
          background: #15201d;
          color: #fff;
          padding: 14px;
          white-space: pre-wrap;
        }
        @media (max-width: 900px) {
          .threePane {
            grid-template-columns: 1fr;
          }
          .threePane > aside,
          .threePane > div {
            min-height: auto;
            max-height: 280px;
            overflow: auto;
          }
          .variantRow,
          .printOption,
          .attachGroup {
            grid-template-columns: 1fr 1fr;
          }
        }
      `}</style>
    </section>
  );
}

function VariantRow({
  value,
  printName,
  post,
  updatePrint,
}: {
  value: Variant;
  printName: string;
  post: (b: any) => Promise<any>;
  updatePrint: (
    type: string,
    id: string,
    field: string,
    value: unknown,
  ) => Promise<void>;
}) {
  const [price, setPrice] = useState(dollars(value.base_price_cents)),
    [name, setName] = useState(value.name);
  return (
    <div className="row variantRow">
      <input
        aria-label="Variant name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        aria-label="Variant price"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
      />
      <input
        aria-label={`${value.name} kitchen print name`}
        defaultValue={printName}
        onBlur={(e) =>
          void updatePrint(
            "variant",
            value.id,
            "print_name",
            e.currentTarget.value,
          )
        }
      />
      <button
        onClick={() =>
          void post({
            action: "update",
            entity: "variant",
            id: value.id,
            patch: { name, basePriceCents: parseMoney(price) },
          })
        }
      >
        Save
      </button>
      <button
        onClick={() =>
          void post({ action: "archive", entity: "variant", id: value.id })
        }
      >
        Archive
      </button>
    </div>
  );
}
function PrintGroupEditor({
  group,
  options,
  updatePrint,
}: {
  group: PrintGroup;
  options: PrintOption[];
  updatePrint: (
    type: string,
    id: string,
    field: string,
    value: unknown,
    reset?: boolean,
    itemId?: string,
  ) => Promise<void>;
}) {
  return (
    <details className="printGroup">
      <summary>{group.group_name} printing</summary>
      <label>
        <input
          type="checkbox"
          checked={Boolean(group.header_modifier)}
          onChange={(e) =>
            void updatePrint(
              "modifier",
              group.group_id,
              "header_modifier",
              e.target.checked,
              false,
              group.item_id,
            )
          }
        />{" "}
        Append non-default choice to item name
      </label>
      <label>
        <input
          type="checkbox"
          checked={group.suppress_default_on_ticket !== false}
          onChange={(e) =>
            void updatePrint(
              "modifier",
              group.group_id,
              "suppress_default_on_ticket",
              e.target.checked,
              false,
              group.item_id,
            )
          }
        />{" "}
        Suppress unchanged defaults
      </label>
      {options.map((option) => (
        <div className="printOption" key={option.id}>
          <b>{option.imported_name}</b>
          <input
            aria-label={`${option.imported_name} print name`}
            defaultValue={option.effective_print_name}
            onBlur={(e) =>
              void updatePrint(
                "modifier_option",
                option.id,
                "print_name",
                e.currentTarget.value,
              )
            }
          />
          <input
            aria-label={`${option.imported_name} print order`}
            type="number"
            defaultValue={option.print_order}
            onBlur={(e) =>
              void updatePrint(
                "modifier_option",
                option.id,
                "print_order",
                Number(e.currentTarget.value),
              )
            }
          />
          <input
            aria-label={`${option.imported_name} print section`}
            placeholder="Print section"
            defaultValue={option.print_section || ""}
            onBlur={(e) =>
              void updatePrint(
                "modifier_option",
                option.id,
                "print_section",
                e.currentTarget.value,
              )
            }
          />
          <label>
            <input
              type="checkbox"
              checked={option.suppress_when_default ?? option.default_selected}
              onChange={(e) =>
                void updatePrint(
                  "modifier_option",
                  option.id,
                  "suppress_when_default",
                  e.target.checked,
                )
              }
            />{" "}
            Suppress default
          </label>
          <label>
            <input
              type="checkbox"
              checked={option.print_only_when_changed ?? false}
              onChange={(e) =>
                void updatePrint(
                  "modifier_option",
                  option.id,
                  "print_only_when_changed",
                  e.target.checked,
                )
              }
            />{" "}
            Only if changed
          </label>
        </div>
      ))}
    </details>
  );
}
function GroupEditor({
  group,
  post,
}: {
  group: Group;
  post: (b: any) => Promise<any>;
}) {
  const [min, setMin] = useState(group.min_selections),
    [max, setMax] = useState(group.max_selections),
    [name, setName] = useState(group.name);
  return (
    <div className="row">
      <input value={name} onChange={(e) => setName(e.target.value)} />
      <label>
        Min
        <input
          type="number"
          min="0"
          value={min}
          onChange={(e) => setMin(Number(e.target.value))}
        />
      </label>
      <label>
        Max
        <input
          type="number"
          min="1"
          value={max}
          onChange={(e) => setMax(Number(e.target.value))}
        />
      </label>
      <button
        onClick={() =>
          void post({
            action: "update",
            entity: "modifier_group",
            id: group.id,
            patch: { name, minSelections: min, maxSelections: max },
          })
        }
      >
        Save
      </button>
    </div>
  );
}
function OptionRow({
  option,
  post,
}: {
  option: Option;
  post: (b: any) => Promise<any>;
}) {
  const [name, setName] = useState(option.name),
    [price, setPrice] = useState(dollars(option.price_delta_cents));
  return (
    <div className="row">
      <input value={name} onChange={(e) => setName(e.target.value)} />
      <input
        aria-label={`${option.name} price`}
        value={price}
        onChange={(e) => setPrice(e.target.value)}
      />
      <button
        onClick={() =>
          void post({
            action: "update",
            entity: "modifier_option",
            id: option.id,
            patch: { name, priceDeltaCents: parseMoney(price) },
          })
        }
      >
        Save
      </button>
      <button
        onClick={() =>
          void post({
            action: "archive",
            entity: "modifier_option",
            id: option.id,
          })
        }
      >
        Archive
      </button>
    </div>
  );
}
