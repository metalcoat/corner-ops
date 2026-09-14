export type PizzaSize = "small" | "regular" | "jumbo";
export type Topping = "pepperoni" | "sausage" | "mushrooms" | "onions" | "peppers" | "olives" | "hot-peppers" | "extra-cheese";
export type PizzaTicket={id:string;customer:string;size:PizzaSize;toppings:Topping[];slices:number;wellDone?:boolean;patienceSeconds:number;createdAt:number;boss?:string};
export type PizzaBuild={ticketId:string;size?:PizzaSize;dough:number;sauceOz:number;cheeseOz:number;toppings:Record<string,{count:number;spread:number}>;bakeSeconds:number;slices?:number;boxed:boolean};
export type GauntletStats={profit:number;sanity:number;reputation:number;accuracy:number;ordersCompleted:number;pizzasMade:number;complaints:number;remakes:number;waste:number;tips:number;combo:number;highestCombo:number;unfairComplaints:number};
export type GauntletEvent={id:string;title:string;message:string;minStage:number;weight:number;cooldown:number;effects:Partial<Pick<GauntletStats,"profit"|"sanity"|"reputation"|"tips"|"waste"|"remakes"|"complaints"|"unfairComplaints">>;choices?:Array<{label:string;result:string;effects:GauntletEvent["effects"]}>};
export type StageConfig={id:number;name:string;subtitle:string;ordersRequired:number;concurrentTickets:number;guidance:"full"|"partial"|"none";ticketSeconds:number;eventChance:number;boss?:string};
export type RunCheckpoint={runId:string;stage:number;stats:GauntletStats;activeSeconds:number;stageOrders:number;sequence:number};
