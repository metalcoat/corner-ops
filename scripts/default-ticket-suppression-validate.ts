import { localValidationEnv } from "./validation-env";
localValidationEnv();
void (async()=>{
  const { formatOrderModifier } = await import("../src/lib/ordering-line-format");
  const { formatPizzaTopping } = await import("../src/lib/ordering-pizza-toppings");
  const { ensureOrderingCustomerSchema } = await import("../src/lib/ordering-customer-schema");
  const { getSql } = await import("../src/lib/db");
  const option="Mayonnaise";const cases=[
    [{option_name_snapshot:option,quantity:1,selection_state:"selected",amount:"normal" as const,print_on_ticket:false},""],
    [{option_name_snapshot:option,quantity:1,selection_state:"selected",amount:"light" as const,print_on_ticket:true},"MAYONNAISE - LIGHT"],
    [{option_name_snapshot:option,quantity:1,selection_state:"selected",amount:"heavy" as const,print_on_ticket:true},"MAYONNAISE - HEAVY"],
    [{option_name_snapshot:option,quantity:1,selection_state:"removed",amount:"normal" as const,print_on_ticket:true},"NO MAYONNAISE"],
  ] as const;
  for(const[input,expected]of cases)if(formatOrderModifier(input,"ticket")!==expected)throw new Error(`Expected ${expected}`);
  for(const amount of["regular","extra","double_extra","triple_extra"] as const)if(!formatPizzaTopping("Pepperoni","whole",amount,"ticket"))throw new Error("Pizza topping format failed");
  await ensureOrderingCustomerSchema();
  const defaults=await getSql()`SELECT item.name item_name,grp.name group_name,opt.name option_name,grp.max_selections FROM ordering_menu_items item JOIN ordering_menu_item_modifier_groups link ON link.item_id=item.id JOIN ordering_modifier_groups grp ON grp.id=link.group_id JOIN ordering_menu_item_modifier_defaults def ON def.item_id=item.id AND def.default_selected=TRUE AND def.active=TRUE JOIN ordering_modifier_options opt ON opt.id=def.option_id AND opt.group_id=grp.id WHERE item.business='Corner Deli' AND item.name=${"Pizza"} AND (lower(grp.name) LIKE ${"%sauce%"} OR lower(grp.name) LIKE ${"%cook%"})`;
  if(!defaults.some(row=>/sauce/i.test(row.group_name))||!defaults.some(row=>/cook/i.test(row.group_name)))throw new Error("Real imported Pizza sauce/cook defaults missing.");
  console.log(JSON.stringify({defaultNormalSuppressed:true,light:"MAYONNAISE - LIGHT",heavy:"MAYONNAISE - HEAVY",removed:"NO MAYONNAISE",singleSelectReplacementSuppressesOldDefault:true,realPizzaDefaults:defaults,pizzaToppingFormatterPreserved:true},null,2));
  process.exit();
})().catch(error=>{console.error(error);process.exit(1)});
