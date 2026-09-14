export const DELIVERY_STAGES=[
 {name:"Training Route",deliveries:4,speed:150,time:70,hazards:5},
 {name:"Dinner Run",deliveries:6,speed:180,time:75,hazards:8},
 {name:"Deer O'Clock",deliveries:7,speed:210,time:78,hazards:11},
 {name:"Friday Night",deliveries:8,speed:235,time:80,hazards:14},
 {name:"Last Run",deliveries:10,speed:265,time:85,hazards:18},
] as const;
export const DELIVERY_PRIZE={name:"One Free Regular Sub",terms:"One regular cold or hot sub. Extras and premium upgrades regular price.",expiresDays:30};
export const DELIVERY_COMPLAINTS=[
 "Customer says you never arrived. Route log: you stared at each other through the storm door for 2:07.",
 "Customer reports the sub was shaken. The road reports the customer owns a driveway made entirely of potholes.",
 "Customer asked for quiet delivery, then called because you did not knock.",
 "Customer says you were late. They entered the wrong address and remain furious at geography.",
 "Customer watched you approach through the blinds, waited for you to leave, then reported no delivery attempt.",
 "Customer says the bag was six inches left of where they expected it. Investigation ongoing.",
 "Customer requested FRONT DOOR. House contains seven doors and no visible front.",
 "Customer says the fries shifted during transit. Gravity has been notified.",
 "Customer claims the deer in their driveway is your employee and wants a manager.",
 "Customer says delivery was too fast and they weren't emotionally prepared for dinner.",
] as const;
