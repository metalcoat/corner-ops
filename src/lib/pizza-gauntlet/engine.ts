import { PIZZA_SIZES, TOPPINGS } from "./config";
import type { GauntletStats, PizzaBuild, PizzaTicket, PizzaSize, Topping } from "./types";

export const INITIAL_STATS: GauntletStats = { profit:75,sanity:100,reputation:75,accuracy:100,ordersCompleted:0,pizzasMade:0,complaints:0,remakes:0,waste:0,tips:0,combo:0,highestCombo:0,unfairComplaints:0 };
export const clamp=(n:number,min=0,max=100)=>Math.max(min,Math.min(max,n));
const closeness=(actual:number,target:number,tolerance:number)=>clamp(100-(Math.abs(actual-target)/tolerance)*100);

export function scorePizza(build:PizzaBuild,ticket:PizzaTicket){
 const recipe=PIZZA_SIZES[ticket.size], selected=build.size===ticket.size?100:0;
 const dough=closeness(build.dough,100,40), sauce=closeness(build.sauceOz,recipe.sauce,recipe.sauce*.5)*.75+(build.sauceSpread??100)*.25, cheese=closeness(build.cheeseOz,recipe.cheese,recipe.cheese*.45)*.75+(build.cheeseSpread??100)*.25;
 const requested=new Set<string>(ticket.toppings), supplied=new Set<string>(Object.keys(build.toppings).filter(k=>build.toppings[k].count>0));
 const correct=[...requested].filter(x=>supplied.has(x)).length, extras=[...supplied].filter(x=>!requested.has(x)).length;
 const topping=requested.size?clamp((correct/requested.size)*100-extras*30):supplied.size?0:100;
 const distribution=requested.size?[...requested].reduce((n,t)=>n+(build.toppings[t]?.spread||0),0)/requested.size:100;
 const targetBake=recipe.bake+(ticket.wellDone?2:0), bake=closeness(build.bakeSeconds,targetBake,3), cut=build.slices===ticket.slices?100:Math.max(0,100-Math.abs((build.slices||0)-ticket.slices)*20);
 const accuracy=Math.round(selected*.15+dough*.1+sauce*.15+cheese*.15+topping*.18+distribution*.1+bake*.12+cut*.05);
 return {accuracy,perfect:accuracy>=96,parts:{size:selected,dough:Math.round(dough),sauce:Math.round(sauce),cheese:Math.round(cheese),toppings:Math.round(topping),distribution:Math.round(distribution),bake:Math.round(bake),cut:Math.round(cut)}};
}

export function comboMultiplier(combo:number){return combo>=20?2.5:combo>=10?2:combo>=5?1.5:combo>=3?1.25:1}
export function randomTicket(stage:number,index:number,now=Date.now()):PizzaTicket{
 const sizes:PizzaSize[]=stage<2?["regular"]:["small","regular","jumbo"], size=sizes[Math.floor(Math.random()*sizes.length)];
 const keys=Object.keys(TOPPINGS) as Topping[], count=Math.min(stage===1?1:Math.floor(Math.random()*(Math.min(stage,4)+1)),keys.length);
 const toppings=[...keys].sort(()=>Math.random()-.5).slice(0,count);
 const names=["Pat","Sam","Chris","Jordan","The person already at the counter","PHONE 2","ONLINE #"+(100+index)];
 return {id:`ticket-${now}-${index}`,customer:names[index%names.length],size,toppings,slices:Math.random()<.12?6:8,wellDone:stage>1&&Math.random()<.15,patienceSeconds:Math.max(55,165-stage*14),createdAt:now};
}
