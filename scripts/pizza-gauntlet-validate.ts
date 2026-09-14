import assert from "node:assert/strict";
import { EVENTS,PIZZA_SIZES,STAGES } from "../src/lib/pizza-gauntlet/config";
import { comboMultiplier,scorePizza } from "../src/lib/pizza-gauntlet/engine";
const ticket={id:"t",customer:"Test",size:"jumbo" as const,toppings:["pepperoni" as const],slices:8,patienceSeconds:90,createdAt:0};
const recipe=PIZZA_SIZES.jumbo;
const perfect=scorePizza({ticketId:"t",size:"jumbo",dough:100,sauceOz:recipe.sauce,cheeseOz:recipe.cheese,toppings:{pepperoni:{count:24,spread:100}},bakeSeconds:recipe.bake,slices:8,boxed:true},ticket);
assert.equal(perfect.accuracy,100);assert.equal(perfect.perfect,true);assert.equal(comboMultiplier(3),1.25);assert.equal(comboMultiplier(5),1.5);assert.equal(comboMultiplier(10),2);assert.ok(EVENTS.length>=40);assert.equal(STAGES.length,6);assert.equal(STAGES.at(-1)?.boss,"The Fourteen-Pizza Farewell");
console.log(`Pizza Gauntlet validation passed: ${EVENTS.length} events, ${STAGES.length} stages, perfect score ${perfect.accuracy}.`);
