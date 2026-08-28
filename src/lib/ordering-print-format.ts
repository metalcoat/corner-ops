import { getSql } from "@/lib/db";
import { ensureOrderingMenuOverrideSchema } from "@/lib/ordering-menu-overrides";
import { formatModifierIntensity } from "@/lib/ordering-modifier-intensity";
import { kitchenPortionName, pizzaKitchenModifierOrder } from "@/lib/ordering-line-format";

export type PrintableModifier = { name: string; printOrder: number; header: boolean; print: boolean; group?: string; pizzaPortion?: "left_half"|"whole"|"right_half"|null; pizzaAmount?: string|null };
export type PrintableLine = { quantity: number; header: string; modifiers: PrintableModifier[]; family?: string; sequence?: number };

const key=(value:string)=>value.toLocaleLowerCase().replace(/[^a-z0-9]+/g," ").trim();
export function kitchenItemFamily(itemName:string,categoryName=""){
  const item=key(itemName),category=key(categoryName);
  if(category.includes("sub")||item.includes("big boss"))return"20-subs";
  if(item.includes("pizza")&&!item.startsWith("pizza log"))return"00-pizza";
  if(item.includes("wing"))return"10-wings";
  if(category.includes("pizza and wing"))return"15-pizza-sides";
  if(category.includes("burger")||category.includes("sandwich")||category.includes("tender")||category.includes("kid"))return"30-grill";
  if(category.includes("appetizer")||category.includes("side dish"))return"40-apps-sides";
  if(category.includes("meal")||category.includes("fish")||category.includes("italian")||category.includes("mexican"))return"50-meals";
  if(category.includes("salad"))return"60-salads";
  if(category.includes("drink")||category.includes("soda")||category.includes("liter")||category.includes("chip")||category.includes("arizona"))return"90-drinks";
  return`70-${category||"other"}`;
}
function namedRank(name:string,names:string[]){const value=key(name);for(let index=0;index<names.length;index++)if(value.includes(names[index]))return(index+1)*10;return undefined}
export function kitchenModifierOrder(line:PrintableLine,modifier:PrintableModifier){
  const family=line.family||kitchenItemFamily(line.header),name=key(modifier.name),group=key(modifier.group||"");
  if(Number.isFinite(modifier.printOrder)&&modifier.printOrder!==0)return modifier.printOrder;
  if(family==="00-pizza"){
    return pizzaKitchenModifierOrder({option_name_snapshot:modifier.name,print_order_snapshot:modifier.printOrder,group_name_snapshot:modifier.group});
  }
  if(family==="20-subs"){
    const rank=namedRank(name,["mayonnaise","mayo","russian","oil","lettuce","tomato","onion","hot pepper","ranch","bacon","a1 sauce","parm shaker","oregano shaker","jalapeno","pickle","mustard","mushroom","black olive","not toasted","extra sauce","double cheese","double meat"]);
    if(rank!==undefined)return rank;
  }
  return modifier.printOrder;
}

function wrapCell(value:string,width:number){const words=value.split(/\s+/),rows:string[]=[];let row="";for(const word of words){if(!row){row=word.slice(0,width);continue}if(`${row} ${word}`.length<=width)row+=` ${word}`;else{rows.push(row);row=word.slice(0,width)}}if(row)rows.push(row);return rows.length?rows:[""]}
function pizzaColumnLines(modifiers:PrintableModifier[]){
  const portions=["left_half","whole","right_half"] as const,width=12;
  if(!modifiers.some(modifier=>modifier.print&&(modifier.pizzaPortion==="left_half"||modifier.pizzaPortion==="right_half")))return[];
  const columns=portions.map(portion=>modifiers.filter(modifier=>modifier.print&&modifier.pizzaPortion===portion).sort((a,b)=>kitchenModifierOrder({quantity:1,header:"Pizza",family:"00-pizza",modifiers},a)-kitchenModifierOrder({quantity:1,header:"Pizza",family:"00-pizza",modifiers},b)||a.name.localeCompare(b.name)).flatMap(modifier=>wrapCell(`${modifier.pizzaAmount&&modifier.pizzaAmount!=="regular"?`${modifier.pizzaAmount==="extra"?"EXTRA":modifier.pizzaAmount==="double_extra"?"2X EXTRA":"3X EXTRA"} `:""}${modifier.name.toUpperCase()}`,width)));
  if(!columns.some(column=>column.length))return[];
  const output=[`${"LEFT".padEnd(width)}|${"WHOLE".padEnd(width)}|RIGHT`,`${"-".repeat(width)}+${"-".repeat(width)}+${"-".repeat(width)}`],height=Math.max(...columns.map(column=>column.length));
  for(let index=0;index<height;index++)output.push(`${(columns[0][index]||"").padEnd(width)}|${(columns[1][index]||"").padEnd(width)}|${columns[2][index]||""}`);
  return output;
}

export function formatKitchenLines(lines: PrintableLine[]): string[] {
  const output: string[] = [];
  const ordered=lines.map((line,index)=>({...line,family:line.family||kitchenItemFamily(line.header),sequence:line.sequence??index})).sort((a,b)=>String(a.family).localeCompare(String(b.family))||Number(a.sequence)-Number(b.sequence));
  for (const line of ordered) {
    const headers = line.modifiers.filter((modifier) => modifier.print && modifier.header).sort((a,b)=>kitchenModifierOrder(line,a)-kitchenModifierOrder(line,b)).map((modifier)=>modifier.name);
    output.push(`${line.quantity > 1 ? `${line.quantity}x ` : ""}${line.header}${headers.length ? ` - ${headers.join(" - ")}` : ""}`);
    const splitPizza=familyIsPizza(line)&&line.modifiers.some(modifier=>modifier.print&&(modifier.pizzaPortion==="left_half"||modifier.pizzaPortion==="right_half"));
    const pizza=splitPizza?pizzaColumnLines(line.modifiers):[];
    if(pizza.length)output.push(...pizza);
    for (const modifier of line.modifiers.filter((value) => value.print && !value.header && (!value.pizzaPortion||!splitPizza)).sort((a,b)=>kitchenModifierOrder(line,a)-kitchenModifierOrder(line,b)||a.name.localeCompare(b.name))) {const amount=modifier.pizzaAmount&&modifier.pizzaAmount!=="regular"?`${modifier.pizzaAmount==="extra"?"EXTRA":modifier.pizzaAmount==="double_extra"?"2X EXTRA":"3X EXTRA"} `:"";output.push(`  ${amount}${modifier.name.toUpperCase()}`)}
  }
  return output;
}

function familyIsPizza(line:PrintableLine){return (line.family||kitchenItemFamily(line.header))==="00-pizza"}

export async function snapshotAndFormatOrder(orderId: string, onlyItemIds?: string[]): Promise<string[]> {
  await ensureOrderingMenuOverrideSchema();
  const sql = getSql();
  await sql`
    UPDATE ordering_order_items line SET item_print_name_snapshot=COALESCE(
      (SELECT NULLIF(print_name,'') FROM ordering_item_variant_print_overrides WHERE variant_id=line.variant_id),
      (SELECT NULLIF(print_name,'') FROM ordering_item_overrides WHERE item_id=line.item_id),
      NULLIF(line.variant_name_snapshot,''),line.item_name_snapshot)
    WHERE line.order_id=${orderId}
  `;
  await sql`
    UPDATE ordering_order_item_modifiers modifier SET
      option_print_name_snapshot=COALESCE((SELECT NULLIF(print_name,'') FROM ordering_modifier_option_print_overrides WHERE option_id=modifier.option_id),modifier.option_name_snapshot),
      print_order_snapshot=COALESCE((SELECT print_order FROM ordering_modifier_option_print_overrides WHERE option_id=modifier.option_id),(SELECT print_order FROM ordering_modifier_presentation_overrides WHERE item_id=(SELECT item_id FROM ordering_order_items WHERE id=modifier.order_item_id) AND group_id=modifier.group_id),0),
      header_modifier_snapshot=COALESCE((SELECT header_modifier FROM ordering_modifier_presentation_overrides WHERE item_id=(SELECT item_id FROM ordering_order_items WHERE id=modifier.order_item_id) AND group_id=modifier.group_id),FALSE)
    WHERE modifier.order_item_id IN (SELECT id FROM ordering_order_items WHERE order_id=${orderId})
  `;
  const rows = onlyItemIds?.length
    ? await sql`SELECT line.id,line.quantity,line.item_name_snapshot,COALESCE(NULLIF(line.item_print_name_snapshot,''),line.item_name_snapshot) header,COALESCE(category.display_name,category.name,'') category_name FROM ordering_order_items line LEFT JOIN ordering_menu_items item ON item.id=line.item_id LEFT JOIN ordering_menu_categories category ON category.id=item.category_id WHERE line.order_id=${orderId} AND line.id=ANY(${onlyItemIds}) ORDER BY line.sort_order,line.created_at,line.id`
    : await sql`SELECT line.id,line.quantity,line.item_name_snapshot,COALESCE(NULLIF(line.item_print_name_snapshot,''),line.item_name_snapshot) header,COALESCE(category.display_name,category.name,'') category_name FROM ordering_order_items line LEFT JOIN ordering_menu_items item ON item.id=line.item_id LEFT JOIN ordering_menu_categories category ON category.id=item.category_id WHERE line.order_id=${orderId} ORDER BY line.sort_order,line.created_at,line.id`;
  const printable: PrintableLine[] = [];
  for (const row of rows) {
    const modifiers = await sql`SELECT COALESCE(NULLIF(option_print_name_snapshot,''),option_name_snapshot) name,group_name_snapshot,print_order_snapshot,header_modifier_snapshot,print_on_ticket,amount,pizza_topping_portion,pizza_topping_amount FROM ordering_order_item_modifiers WHERE order_item_id=${row.id}`;
    printable.push({ quantity:Number(row.quantity),header:kitchenPortionName(String(row.header)),family:kitchenItemFamily(String(row.item_name_snapshot),String(row.category_name)),sequence:printable.length,modifiers:modifiers.map((modifier)=>({name:formatModifierIntensity(String(modifier.name),modifier.amount === "light" || modifier.amount === "heavy" ? modifier.amount : "normal"),group:String(modifier.group_name_snapshot),printOrder:Number(modifier.print_order_snapshot),header:Boolean(modifier.header_modifier_snapshot),print:Boolean(modifier.print_on_ticket),pizzaPortion:modifier.pizza_topping_portion||null,pizzaAmount:modifier.pizza_topping_amount||null})) });
  }
  return formatKitchenLines(printable);
}
