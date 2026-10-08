import type { GauntletEvent, PizzaSize, StageConfig, Topping } from "./types";

export const GAME_TITLE = "The Corner Deli Pizza Gauntlet";
export const PRIZE = { name: "One Free Jumbo Cheese Pizza", toppings: "Additional toppings regular price", expiresDays: 30 };

export const PIZZA_SIZES: Record<PizzaSize, { label: string; inches: number; sauce: number; cheese: number; bake: number; price: number; slices: number }> = {
  small: { label: "Small", inches: 12, sauce: 4, cheese: 7, bake: 4, price: 12.49, slices: 8 },
  regular: { label: "Regular", inches: 14, sauce: 5, cheese: 8.5, bake: 5, price: 14.49, slices: 8 },
  jumbo: { label: "Jumbo", inches: 16, sauce: 6, cheese: 10, bake: 6, price: 16.49, slices: 8 },
};

export const TOPPINGS: Record<Topping, { label: string; color: string; target: number }> = {
  pepperoni: { label: "Pepperoni", color: "#9e2f27", target: 16 }, sausage: { label: "Sausage", color: "#70452f", target: 12 },
  mushrooms: { label: "Mushrooms", color: "#d8c7a7", target: 11 }, onions: { label: "Onions", color: "#eee4cf", target: 10 },
  peppers: { label: "Green Peppers", color: "#4f8d45", target: 10 }, olives: { label: "Black Olives", color: "#292929", target: 10 },
  "hot-peppers": { label: "Hot Peppers", color: "#b9b83b", target: 10 }, "extra-cheese": { label: "Extra Cheese", color: "#f5d56b", target: 12 },
};

export const STAGES: StageConfig[] = [
  { id: 1, name: "Training Shift", subtitle: "The scale still tells the truth.", ordersRequired: 8, concurrentTickets: 1, guidance: "full", ticketSeconds: 70, eventChance: .12 },
  { id: 2, name: "Dinner Rush", subtitle: "Two hands. Four pizzas. Good luck.", ordersRequired: 14, concurrentTickets: 3, guidance: "partial", ticketSeconds: 58, eventChance: .2 },
  { id: 3, name: "Friday Night", subtitle: "The phone has discovered free will.", ordersRequired: 20, concurrentTickets: 5, guidance: "partial", ticketSeconds: 50, eventChance: .28 },
  { id: 4, name: "Football Sunday", subtitle: "Nobody planned ahead. This is your fault.", ordersRequired: 24, concurrentTickets: 6, guidance: "none", ticketSeconds: 44, eventChance: .36, boss: "Little League Team" },
  { id: 5, name: "Full Collapse", subtitle: "Printer offline. Spirit also offline.", ordersRequired: 28, concurrentTickets: 6, guidance: "none", ticketSeconds: 38, eventChance: .44, boss: "Sunday Football" },
  { id: 6, name: "Final Rush", subtitle: "7:52 PM. The phone rings.", ordersRequired: 34, concurrentTickets: 7, guidance: "none", ticketSeconds: 34, eventChance: .52, boss: "The Fourteen-Pizza Farewell" },
];

const rawEvents: Array<[string,string,number,number,Partial<GauntletEvent["effects"]>]> = [
 ["Not Enough Cheese","Required: 10.0 oz. You used: 10.0 oz. The customer remains extremely confident.",1,4,{profit:-16.49,sanity:-6,complaints:1,unfairComplaints:1}],
 ["Loaded, Apparently","“These used to be loaded and now they are shit.” Records indicate the portion has not changed.",2,3,{reputation:-5,sanity:-8,complaints:1,unfairComplaints:1}],
 ["Well-Done Complaint","They ordered well-done and would like to report that it is well-done.",2,3,{sanity:-5,complaints:1}],
 ["Light Cheese Emergency","Light cheese is, in fact, lighter than regular cheese. This is unacceptable.",2,3,{reputation:-2,sanity:-4,complaints:1}],
 ["Phantom Onions","The ticket says onions. The customer says the ticket is lying.",2,4,{profit:-8,sanity:-5,complaints:1}],
 ["Ninety Seconds","A customer asks where the pizza is. It has been ninety seconds.",1,5,{sanity:-3}],
 ["Pickup Delivery","A pickup customer calls asking where the driver is.",2,4,{sanity:-4}],
 ["The Stare","A delivery-app driver arrives 17 minutes early and stares directly through the kitchen.",2,4,{sanity:-3}],
 ["Wrong Restaurant","They ordered somewhere else, but feel you should personally resolve this.",2,3,{sanity:-5}],
 ["Knows the Owner","The owner remains unaware of this important friendship.",2,4,{reputation:-1,sanity:-4}],
 ["Thirty-Year Veteran","They have been coming here for 30 years and have never seen cheese before.",3,3,{sanity:-5}],
 ["Mystery Illness","An employee calls in sick and is immediately tagged at the mall.",3,3,{sanity:-10}],
 ["Paper Out","The printer makes a heroic final beep and dies.",3,4,{sanity:-6,profit:-3}],
 ["Internet Down","The router's only diagnostic light is emotional damage.",4,3,{sanity:-8,reputation:-2}],
 ["Cold Oven","The oven temperature falls 75 degrees because it felt like it.",4,3,{profit:-12,waste:1}],
 ["Gravity","Someone drops a finished pizza cheese-side down.",3,3,{profit:-16,waste:1,sanity:-6,remakes:1}],
 ["Phone Rings","Naturally, it rings while both hands are covered in sauce.",2,6,{sanity:-2}],
 ["7:58 PM","A cheerful voice asks whether 11 pizzas is ‘too many.’",4,2,{sanity:-8}],
 ["The Manager","They demand the manager. You rotate slowly in place and return.",3,3,{sanity:-5}],
 ["Facebook Economist","A local expert publishes a 900-word analysis of cheese pricing.",3,3,{reputation:-3,sanity:-4}],
 ["Contradictory Notes","NO ONIONS. EXTRA ONIONS. ALLERGY. PLEASE HURRY.",3,4,{sanity:-4}],
 ["Very Early","They arrived before clicking Place Order and are disappointed in the wait.",2,4,{sanity:-3}],
 ["Very Late","Two hours later, they report that hot food becomes less hot over time.",3,3,{reputation:-2,complaints:1}],
 ["MIRACLE","Everything was great. They said thank you. Nobody knows what to do.",1,2,{sanity:15,tips:4,reputation:3}],
 ["Exact Change","A customer pays exact change and leaves before adding a new problem.",1,3,{sanity:4}],
 ["Big Tip","A regular quietly leaves twelve dollars.",2,2,{tips:12,sanity:8}],
 ["Dishwasher Appears","The dishwasher finishes everything without being asked. Suspicious, but welcome.",3,2,{sanity:10}],
 ["Compliment to the Cook","A customer calls back only to say the pizza was excellent.",2,2,{reputation:5,sanity:9}],
 ["Door Won't Close","The walk-in door chooses the dinner rush for its independence.",4,3,{profit:-6,sanity:-5}],
 ["No Pennies","Someone wants exact change from a hundred-dollar bill at opening.",2,3,{sanity:-4}],
 ["Coupon Archaeology","A coupon from 2007 is presented in nearly readable condition.",2,3,{sanity:-5,profit:-2}],
 ["Birthday Order","Nobody wrote down which pizza gets the birthday message.",3,3,{sanity:-4,reputation:-1}],
 ["Cheese Avalanche","The cheese bin catches an apron and chooses freedom.",4,2,{waste:2,profit:-10,sanity:-5}],
 ["Silent Phone","The caller says hello while muted, then blames the deli.",3,3,{sanity:-3}],
 ["Separate Checks","A twelve-pizza order would now like eleven separate payments.",4,2,{sanity:-8}],
 ["Parking Lot Logistics","Curbside customer parks at another business and says ‘I'm by a car.’",3,3,{sanity:-4}],
 ["Helpful Child","A child rearranges every parmesan shaker while maintaining eye contact.",2,2,{sanity:-3}],
 ["Last Slice","Staff discovers one perfect leftover slice. Morale briefly exists.",3,2,{sanity:7}],
 ["Good Regular","A regular recognizes the rush, waits patiently, and tips well.",3,2,{tips:8,reputation:3,sanity:6}],
 ["Power Flicker","Every oven timer resets to 00:00 for one exciting second.",5,2,{sanity:-9,waste:1}],
 ["Health Inspector Lunch","They are just ordering lunch. Nobody believes them.",4,2,{sanity:-6}],
 ["Sauce Lid","The sauce lid was not attached. Physics completes the task.",2,3,{waste:1,profit:-5}],
 ["Perfect Timing","Three orders arrive exactly when their food is boxed.",2,2,{reputation:4,tips:5,sanity:5}],
 ["Receipt Roll","The replacement roll is the wrong width, despite living in the right box.",3,3,{sanity:-4}],
 ["Extra Crispy","A customer asks for wings ‘crispy but not dry, wet but not soggy.’",4,3,{sanity:-5}],
 ["DoorDash Oracle","The driver says the app told him the pizza would be ready before it was ordered.",2,4,{sanity:-4}],
 ["Structural Ranch Failure","Customer says the ranch cup felt emotionally underfilled.",2,3,{sanity:-4,reputation:-1}],
 ["Crust Lawsuit","They did not eat the crust and would now like a refund for the unused perimeter.",2,3,{profit:-4,sanity:-5}],
 ["Invisible Pepperoni","Customer removed every pepperoni, photographed the cheese underneath, and has evidence.",3,3,{reputation:-3,sanity:-7,unfairComplaints:1}],
 ["Temperature Research","Customer drove around for 48 minutes and discovered the pizza is no longer oven temperature.",2,4,{sanity:-5,complaints:1}],
 ["Cheese Orientation","The cheese slid to one side when they held the box vertically. This is a kitchen issue.",3,3,{sanity:-7,reputation:-2}],
 ["The Old Price","They remember this pizza costing six dollars. Follow-up questions reveal this was 1989.",2,3,{sanity:-4}],
 ["Parking Lot Summoning","Curbside customer refuses to describe their vehicle because ‘you should see me.’",3,4,{sanity:-5}],
 ["One Star Physics","Review: ‘Pizza was hot. Had to wait for it to cool. One star.’",3,3,{reputation:-4,sanity:-6,unfairComplaints:1}],
 ["Garlic Emergency","They asked for no garlic after eating the entire garlic pizza.",3,3,{profit:-10,sanity:-6,complaints:1}],
 ["Owner's Cousin's Dentist","A powerful new relationship has been invoked. The discount remains fictional.",4,3,{sanity:-6}],
 ["Closing-Time Mathematics","At 7:59, a customer explains that fourteen pizzas is technically one order.",4,4,{sanity:-9}],
 ["Box Too Square","The pizza is round. The box is square. Customer suspects cost cutting.",3,3,{sanity:-5,unfairComplaints:1}],
 ["Slice Disagreement","Eight slices is apparently less food than six larger slices.",2,4,{sanity:-4}],
 ["Sauce Witness","Customer can tell by looking that the sauce was applied counterclockwise.",4,2,{sanity:-8,unfairComplaints:1}],
];

export const EVENTS: GauntletEvent[] = rawEvents.map((e,i)=>({id:`event-${i+1}`,title:e[0],message:e[1],minStage:e[2],weight:e[3],cooldown:3,effects:e[4]}));

export const BOSS_ORDERS = {
  "Little League Team": { pizzas: 8, note: "Eight pizzas, 60 wings, four fries, and nine adults changing the order." },
  "Sunday Football": { pizzas: 10, note: "Ten jumbos, 100 wings, four large fries. Ready in twenty minutes, right?" },
  "The Fourteen-Pizza Farewell": { pizzas: 14, note: "7:52 PM: fourteen different pizzas while the existing rail remains full." },
};
