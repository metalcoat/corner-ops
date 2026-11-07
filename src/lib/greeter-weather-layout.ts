/**
 * Where the TV weather slide (1920×1080) leaves room for the Pi's animations: the "sky"
 * beside the current temperature and an icon spot on each of the three day cards.
 * Shared by the PNG (/api/pos/greeter/weather) and the layout the Pi reads
 * (/api/pos/greeter/weather/info), so they always agree. Rectangles are [x, y, w, h].
 */
export const WEATHER_SLIDE = { width: 1920, height: 1080 };
export const HERO = { left: 90, top: 225, width: 900 };
export const SKY: [number, number, number, number] = [1010, 190, 860, 430];
export const CARDS = { top: 650, height: 360, left: 90, gap: 36, count: 3 };
export const CARD_WIDTH = (WEATHER_SLIDE.width - 2 * CARDS.left - (CARDS.count - 1) * CARDS.gap) / CARDS.count;
export const CARD_ICON = 160;

export function cardRect(index: number): [number, number, number, number] {
  return [CARDS.left + index * (CARD_WIDTH + CARDS.gap), CARDS.top, CARD_WIDTH, CARDS.height];
}

/** The icon spot in a card's top-right corner. */
export function cardIconRect(index: number): [number, number, number, number] {
  const [x, y, w] = cardRect(index);
  return [Math.round(x + w - CARD_ICON - 26), y + 26, CARD_ICON, CARD_ICON];
}
