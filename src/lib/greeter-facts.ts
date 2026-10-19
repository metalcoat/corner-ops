/**
 * "Did you know?" facts for the TV greeter's fun-fact slide (one per turn of the rotation).
 * Keep each one short (it has to be read across the room in 15 seconds), family-friendly,
 * and true; hedge legends ("said to", "legend says"). Add or reword freely.
 */
export type GreeterFact = { topic: string; text: string };

export const GREETER_FACTS: GreeterFact[] = [
  { topic: "Deli", text: "“Deli” is short for delicatessen, from the German word for “delicacies.”" },
  { topic: "Sandwiches", text: "The sandwich is said to be named after the 4th Earl of Sandwich, who ate meat between bread so he wouldn’t have to leave his card game." },
  { topic: "Ogdensburg", text: "Fort de la Présentation was founded here in 1749, making Ogdensburg one of the oldest settlements in Northern New York." },
  { topic: "Food science", text: "Botanically speaking, bananas are berries. Strawberries aren’t." },
  { topic: "New York", text: "Buffalo wings were first served at the Anchor Bar in Buffalo, New York, in 1964." },
  { topic: "Cheese", text: "The holes in Swiss cheese are called “eyes.”" },
  { topic: "New York", text: "Yogurt is New York’s official state snack. It got the title in 2014." },
  { topic: "Food science", text: "Peanuts aren’t nuts. They’re legumes, like peas and beans." },
  { topic: "Ogdensburg", text: "The Ogdensburg–Prescott International Bridge opened across the St. Lawrence River in 1960." },
  { topic: "Pizza", text: "Pizza Margherita is said to be named after Queen Margherita of Italy, who visited Naples in 1889." },
  { topic: "Cheese", text: "Cheddar is naturally white. Orange cheddar gets its color from annatto, a seed from the achiote tree." },
  { topic: "New York", text: "The apple muffin is New York’s official state muffin." },
  { topic: "Coffee", text: "Coffee beans are the seeds of a fruit called the coffee cherry." },
  { topic: "Ogdensburg", text: "The Frederic Remington Art Museum, home to the famous Western artist’s work, is right here in Ogdensburg." },
  { topic: "Food history", text: "Ketchup was sold as a medicine in the 1830s." },
  { topic: "Food science", text: "Carrots weren’t always orange. Early carrots were mostly purple or yellow." },
  { topic: "New York", text: "Legend says potato chips were first made in Saratoga Springs, New York, in 1853." },
  { topic: "Food history", text: "People were baking bread at least 14,000 years ago, thousands of years before farming began." },
  { topic: "Food science", text: "Honey keeps almost forever. Pots of honey found in ancient Egyptian tombs were still edible." },
  { topic: "New York", text: "New York grows more apples than any state except Washington." },
  { topic: "Cheese", text: "Traditional mozzarella from southern Italy is made from water buffalo milk." },
  { topic: "Ogdensburg", text: "The St. Lawrence River flowing past Ogdensburg links the Great Lakes to the Atlantic Ocean." },
];
