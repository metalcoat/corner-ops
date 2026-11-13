-- The store's real checklist jobs (Chris, 2026-11-09), replacing the placeholders 0049 seeded, plus:
--  * how_to: a short how-to note staff can open with a small "How" button without checking the job off;
--  * video_url: an optional YouTube how-to video, played in an overlay on the screen;
--  * count jobs: count_fields asks for numbers (On hand / Made …) with the tick, saved in store_checklist_checks.counts;
--    count_key ties the same thing across lists (start of day, shift change, close) for the manager's usage table.
-- Old placeholder jobs that were ever ticked are switched off (history kept); the rest are deleted. Jobs a manager
-- renamed (placeholder cleared) are left alone. Safe to run again: new jobs are only added when missing.
ALTER TABLE store_checklist_items ADD COLUMN IF NOT EXISTS how_to text NOT NULL DEFAULT '';
ALTER TABLE store_checklist_items ADD COLUMN IF NOT EXISTS video_url text NOT NULL DEFAULT '';
ALTER TABLE store_checklist_items ADD COLUMN IF NOT EXISTS count_fields text[] NOT NULL DEFAULT '{}';
ALTER TABLE store_checklist_items ADD COLUMN IF NOT EXISTS count_key text NOT NULL DEFAULT '';
ALTER TABLE store_checklist_checks ADD COLUMN IF NOT EXISTS counts jsonb;

DROP TABLE IF EXISTS checklist_old_seed;
CREATE TEMP TABLE checklist_old_seed (list_name text, label text) ON COMMIT DROP;
INSERT INTO checklist_old_seed VALUES
  ('Opening', 'Turn on fryers and ovens'),
  ('Opening', 'Count and open the till'),
  ('Opening', 'Check walk-in and cooler temps'),
  ('Opening', 'Check dates on deli salads'),
  ('Opening', 'Stock the line'),
  ('Opening', 'Unlock doors and turn on the open sign'),
  ('Mid-day', 'Restock napkins, cups and lids'),
  ('Mid-day', 'Wipe tables and counters'),
  ('Mid-day', 'Empty trash if full'),
  ('Mid-day', 'Restock the line for dinner'),
  ('Closing', 'Mop up front'),
  ('Closing', 'Mop the kitchen'),
  ('Closing', 'Clean the slicer'),
  ('Closing', 'Wipe down tables'),
  ('Closing', 'Take out the trash'),
  ('Closing', 'Clean fryers and filter oil'),
  ('Closing', 'Wrap and date all food'),
  ('Closing', 'Sweep'),
  ('Closing', 'Restock drinks'),
  ('Closing', 'Lock doors');

UPDATE store_checklist_items item SET archived_at = COALESCE(item.archived_at, now()), updated_by = 'seed', updated_at = now()
FROM store_checklists list, checklist_old_seed old
WHERE list.id = item.checklist_id AND list.business = 'Corner Deli' AND list.name = old.list_name AND item.label = old.label
  AND item.placeholder AND EXISTS (SELECT 1 FROM store_checklist_checks tick WHERE tick.item_id = item.id);

DELETE FROM store_checklist_items item
USING store_checklists list, checklist_old_seed old
WHERE list.id = item.checklist_id AND list.business = 'Corner Deli' AND list.name = old.list_name AND item.label = old.label
  AND item.placeholder AND NOT EXISTS (SELECT 1 FROM store_checklist_checks tick WHERE tick.item_id = item.id);

INSERT INTO store_checklist_items (checklist_id, business, label, how_to, placeholder, count_fields, count_key, position, updated_by)
SELECT list.id, 'Corner Deli', job.label, job.how_to, job.placeholder, job.count_fields, job.count_key, job.position, 'seed'
FROM (VALUES
  ('Opening', 'Fryers set to 180 °C', 'All fryers 180 °C (Celsius), no higher.', false, ARRAY[]::text[], '', 10),
  ('Opening', 'Clean steam table (if needed)', 'Remove all the water, scrub, rinse, vacuum the water out.', false, ARRAY[]::text[], '', 20),
  ('Opening', 'Empty walk-in cooler tray (bucket)', '', false, ARRAY[]::text[], '', 30),
  ('Opening', 'Sub rolls', 'Made in-house. Count what''s out before making, then enter how many you made.', false, ARRAY['On hand','Made today']::text[], 'sub-rolls', 40),
  ('Opening', 'Hamburger buns', 'Made in-house. Count before, then how many you made.', false, ARRAY['On hand','Made today']::text[], 'hamburger-buns', 50),
  ('Opening', 'Pizza dough count', 'Count the dough on hand at the start of the shift, then enter how much you made.', false, ARRAY['On hand','Made today']::text[], 'pizza-dough', 60),
  ('Opening', 'Antipasto meats thawed', 'Enough for the day: bologna, capicola, salami, ham.', false, ARRAY[]::text[], '', 70),
  ('Opening', 'Pizza sausage', 'One in the pizza prep, one always thawing. When you move one to the prep table, move one from the freezer to the walk-in. Cut fully out of the wrapper, Saran tight, no air.', false, ARRAY[]::text[], '', 80),
  ('Opening', 'Ground beef thawed', 'Same as sausage: one open, one thawing. Reportion 20 lb packs. Never leave thawed meat in its wrapper; Saran tight, no air.', false, ARRAY[]::text[], '', 90),
  ('Opening', 'Chili portioned', 'Out of the bag into 4 oz cups, back into the freezer. Pull cups as needed.', false, ARRAY[]::text[], '', 100),
  ('Opening', 'Nacho chips fried', 'Come pre-cut. Fry enough for the day and store in the bin.', false, ARRAY[]::text[], '', 110),
  ('Opening', 'Queso shells thawed', 'Enough for the day.', false, ARRAY[]::text[], '', 120),
  ('Opening', 'Nacho cheese', 'Machine loaded plus one on deck.', false, ARRAY[]::text[], '', 130),
  ('Opening', 'Wing sauce bottles filled', 'Mild = yellow bottle, Medium = clear, Hot = brown. Everything else goes in clear.', false, ARRAY[]::text[], '', 140),
  ('Opening', 'Make Mild wing sauce (if needed)', '1 gal Country French + 1 gal hot sauce.', false, ARRAY[]::text[], '', 150),
  ('Opening', 'Make Medium wing sauce (if needed)', '1 gal Ken''s Deluxe + 1 gal hot sauce.', false, ARRAY[]::text[], '', 160),
  ('Opening', 'Make Hot wing sauce (if needed)', '1 gal French + 2 gal hot sauce.', false, ARRAY[]::text[], '', 170),
  ('Opening', 'Pizza prep table filled', 'Sauce, cheese, pepperoni, peppers, mushrooms, onions. Enough for the day. Always put old on top of new.', false, ARRAY[]::text[], '', 180),
  ('Opening', 'Dressing bottles filled to the top', 'Ranch, Italian, and 2 Russian for the sub dispensers.', false, ARRAY[]::text[], '', 190),
  ('Opening', 'Sub tomatoes', 'One full on the line (no backup needed). Save the scraps for taco salad and nacho supreme.', false, ARRAY[]::text[], '', 200),
  ('Opening', 'Julienne tomatoes', 'Tomato cut into wedges for subs and salads. About one a day.', false, ARRAY[]::text[], '', 210),
  ('Opening', 'Salad veggies', 'Radishes and carrots through the mandoline, peppers hand cut, all in one mixed container.', false, ARRAY[]::text[], '', 220),
  ('Opening', 'Celery cut for wings', '', false, ARRAY[]::text[], '', 230),
  ('Opening', 'Salad lettuce', '', false, ARRAY[]::text[], '', 240),
  ('Opening', 'Sub lettuce', 'Enough for the day, make sure it''s not browned.', false, ARRAY[]::text[], '', 250),
  ('Opening', 'Onions cut', 'Enough for the day for the sub line and pizzas.', false, ARRAY[]::text[], '', 260),
  ('Opening', 'Check whole and sliced olives', 'Both are cans; make sure neither is empty. Low priority.', false, ARRAY[]::text[], '', 270),
  ('Opening', 'Bacon baked', 'On a pizza sheet in the oven at 350 until cooked. Keeps it flat and evenly cooked.', false, ARRAY[]::text[], '', 280),
  ('Opening', 'Bacon bits portioned', 'Open a bag, portion into the clear Cambro containers, keep some frozen and rotate.', false, ARRAY[]::text[], '', 290),
  ('Opening', 'Stock containers up front and by fryer', '', true, ARRAY[]::text[], '', 300),
  ('Opening', 'Check and stir all salads up front', 'Stir every salad. If low, move to a smaller pan; get old pans out, washed and ready.', false, ARRAY[]::text[], '', 310),
  ('Opening', 'Salad sides ready', 'Whenever potatoes, macaroni or pasta are boiled, make the sides at the same time so it''s ready to mix. Never leave cooked potatoes sitting in a bowl. Log each batch in the Deli salads tab.', false, ARRAY[]::text[], '', 320),
  ('Opening', '2 oz and 4 oz cups filled', 'Ranch, blue cheese, sour cream.', false, ARRAY[]::text[], '', 330),
  ('Opening', '4 oz slaws portioned', 'About 8, for chicken tender dinners and similar.', false, ARRAY[]::text[], '', 340),
  ('Opening', 'Pizza cheese shredded', 'Cut the brick in half, then a third off the top, for three even pieces that fit the shredder with even pressure. Shred while still cold. Loose fill buckets to 3/4, never press down, never over.', false, ARRAY[]::text[], '', 350),
  ('Opening', 'Russian dressing (if needed)', 'Half mayo, half ketchup. Always in a pot, never a bowl. Immersion blender. Scrape it all out with a spatula, portion into Hellmann''s jugs only.', false, ARRAY[]::text[], '', 360),
  ('Opening', 'Italian dressing (if needed)', 'Bag instructions, but use 2 bags and double everything, plus 1 cup of sugar. Mix in a pot, never a bowl.', false, ARRAY[]::text[], '', 370),
  ('Opening', 'Spaghetti', 'Enough boiled for the day in the walk-in. Rinse the starch out, make sure it''s dry, into Cambro portion containers.', false, ARRAY[]::text[], '', 380),
  ('Opening', 'Taco meat', 'Grill it, make it, cool it, portion into a Cambro container. Never a metal pan with Saran wrap.', false, ARRAY[]::text[], '', 390),
  ('Opening', 'Brown gravy', 'Made per the packet directions.', true, ARRAY[]::text[], '', 400),
  ('Opening', 'Sub cheese', 'American, provolone, Swiss: one container each, full, laid flat (never sideways), lid must shut. American comes pre-cut.', false, ARRAY[]::text[], '', 410),
  ('Opening', 'Roast beef thawed', 'Just make sure some is thawed. No pre-portioning.', false, ARRAY[]::text[], '', 420),
  ('Opening', 'Inside freezer stocked from back freezer', 'Fries, pizza logs, burgers and the like.', false, ARRAY[]::text[], '', 430),
  ('Opening', 'Stock soda cooler', '', false, ARRAY[]::text[], '', 440),
  ('Mid-day', 'Sub rolls count', 'Count what''s on hand now, and how many were made this shift.', false, ARRAY['On hand','Made this shift']::text[], 'sub-rolls', 10),
  ('Mid-day', 'Hamburger buns count', 'Count what''s on hand now, and how many were made this shift.', false, ARRAY['On hand','Made this shift']::text[], 'hamburger-buns', 20),
  ('Mid-day', 'Pizza dough count', 'Count the dough on hand now, and how much was made this shift.', false, ARRAY['On hand','Made this shift']::text[], 'pizza-dough', 30),
  ('Mid-day', 'Enough pizza boxes for the night', '', false, ARRAY[]::text[], '', 40),
  ('Mid-day', 'Stock soda cooler', '', false, ARRAY[]::text[], '', 50),
  ('Closing', 'Slushie machine on and filled', '', false, ARRAY[]::text[], '', 10),
  ('Closing', 'Sinks empty and clean', 'Nothing in any sink: no food, utensils or dishes. Everything dried and put away.', false, ARRAY[]::text[], '', 20),
  ('Closing', 'Salad spoons out and washed', 'Move salads to smaller pans if possible.', false, ARRAY[]::text[], '', 30),
  ('Closing', 'Steam table pans swapped', 'Marinara and gravy into new pans, ladles off and washed, wrap the new pans and put them in the walk-in.', false, ARRAY[]::text[], '', 40),
  ('Closing', 'Counters wiped down', '', false, ARRAY[]::text[], '', 50),
  ('Closing', 'Sweep', '', false, ARRAY[]::text[], '', 60),
  ('Closing', 'Mop up front', '', false, ARRAY[]::text[], '', 70),
  ('Closing', 'Mop out back', '', false, ARRAY[]::text[], '', 80),
  ('Closing', 'Bathroom clean', '', false, ARRAY[]::text[], '', 90),
  ('Closing', 'All garbages emptied, front and back', '', false, ARRAY[]::text[], '', 100),
  ('Closing', 'Grease trap emptied', '', false, ARRAY[]::text[], '', 110),
  ('Closing', 'Boxes, cans and containers broken down and taken out; cans emptied', '', false, ARRAY[]::text[], '', 120),
  ('Closing', 'Sub rolls count', 'End of the night: count what''s on hand, and how many were made this shift.', false, ARRAY['On hand','Made this shift']::text[], 'sub-rolls', 130),
  ('Closing', 'Hamburger buns count', 'End of the night: count what''s on hand, and how many were made this shift.', false, ARRAY['On hand','Made this shift']::text[], 'hamburger-buns', 140),
  ('Closing', 'Pizza dough count', 'End of the night: count the dough on hand, and how much was made this shift.', false, ARRAY['On hand','Made this shift']::text[], 'pizza-dough', 150)
) AS job(list_name, label, how_to, placeholder, count_fields, count_key, position)
JOIN store_checklists list ON list.business = 'Corner Deli' AND list.name = job.list_name
-- An old placeholder with the same wording that was switched off above (it had ticks) doesn't count as already there.
WHERE NOT EXISTS (SELECT 1 FROM store_checklist_items existing WHERE existing.checklist_id = list.id AND existing.label = job.label
  AND (NOT existing.placeholder OR existing.archived_at IS NULL));
