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

/** Holiday facts, shown instead of the everyday ones while the menu board's season is on. */
export const HOLIDAY_FACTS: Record<string, GreeterFact[]> = {
  halloween: [
    { topic: "Halloween", text: "Halloween grew out of Samhain, an ancient Celtic festival marking the end of the harvest." },
    { topic: "Halloween", text: "The first jack-o’-lanterns were carved from turnips in Ireland and Britain, not pumpkins." },
    { topic: "Pumpkins", text: "Pumpkins are a fruit: they grow from flowers and carry their seeds inside." },
    { topic: "Pumpkins", text: "Illinois grows more pumpkins than any other state." },
    { topic: "Candy", text: "Candy corn dates back to the 1880s, when it was sold as “Chicken Feed.”" },
  ],
  thanksgiving: [
    { topic: "Thanksgiving", text: "The 1621 harvest feast at Plymouth, often called the first Thanksgiving, lasted three days." },
    { topic: "Thanksgiving", text: "Abraham Lincoln made Thanksgiving a national holiday in 1863." },
    { topic: "Thanksgiving", text: "Sarah Josepha Hale, who wrote “Mary Had a Little Lamb,” campaigned for years to make Thanksgiving a national holiday." },
    { topic: "Parades", text: "Macy’s held its first Thanksgiving Day Parade in 1924." },
    { topic: "Turkeys", text: "Wild turkeys can run up to about 25 miles an hour and fly short distances." },
  ],
  christmas: [
    { topic: "Christmas", text: "Decorating Christmas trees became a tradition in Germany before spreading around the world." },
    { topic: "Christmas", text: "Rudolph the Red-Nosed Reindeer was created in 1939 for a Montgomery Ward store booklet." },
    { topic: "Songs", text: "“Jingle Bells” is said to have been written for Thanksgiving, not Christmas." },
    { topic: "Candy", text: "Legend says candy canes were bent into hooks so they could hang on Christmas trees." },
    { topic: "Christmas", text: "In 1950 a Seattle mall put up a Douglas fir about 221 feet tall as its Christmas tree." },
  ],
};

/** The season's holiday facts, or the everyday facts when there are none. */
export function greeterFacts(season: string | null | undefined): GreeterFact[] {
  return HOLIDAY_FACTS[season ?? ""]?.length ? HOLIDAY_FACTS[season ?? ""] : GREETER_FACTS;
}
