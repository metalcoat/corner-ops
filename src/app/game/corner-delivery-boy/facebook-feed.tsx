// The Corner Deli Facebook page parody shown between shifts.
import {
  DELIVERY_COMPLAINTS,
  DELIVERY_FACEBOOK_COMMENTS,
  DELIVERY_FACEBOOK_DELIVERED,
  DELIVERY_FACEBOOK_MISSED,
  DELIVERY_FACEBOOK_PEOPLE,
  DELIVERY_FACEBOOK_PERFECT,
  DELIVERY_FACEBOOK_REPLIES,
  DELIVERY_FACEBOOK_SAMPLES,
  DELIVERY_FACEBOOK_URL,
  DELIVERY_ROUTE_SUCCESSES,
} from "@/lib/delivery-boy/config";
import type { House } from "./street-model";
import { randomComplaint } from "@/lib/games/complaints";

export type FacebookPost = {
  id: number;
  author: string;
  page?: boolean;
  text: string;
  stars?: number;
  reactions: { like: number; haha: number; angry: number };
  comments: { author: string; text: string; page?: boolean }[];
};
const pick = <T,>(items: readonly T[]) =>
  items[Math.floor(Math.random() * items.length)];
const shuffle = <T,>(items: T[]) => {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
};
const fill = (text: string, values: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
export const reactions = (heat: number) => ({
  like: Math.floor(Math.random() * 40) + 3,
  haha: Math.floor(Math.random() * 180 * heat) + 12,
  angry: Math.floor(Math.random() * 25 * heat),
});
/**
 * The Corner Deli Facebook page after a shift: the page brags, then the
 * customers complain anyway, including the ones whose food landed perfectly.
 */
export function buildFeed(log: House[], shiftCleared: boolean): FacebookPost[] {
  let id = 0;
  const people = shuffle([...DELIVERY_FACEBOOK_PEOPLE]);
  const someone = () => people[id++ % people.length];
  const comments = (count: number) =>
    Array.from({ length: count }, () => {
      const author = someone();
      return {
        author,
        text: fill(pick(DELIVERY_FACEBOOK_COMMENTS), { name: someone() }),
      };
    });
  const post = (
    text: string,
    house: House | null,
    heat: number,
    stars?: number,
  ): FacebookPost => ({
    id: ++id,
    author: someone(),
    text: fill(text, {
      item: house?.item ?? "sub",
      address: house?.address ?? "my house",
    }),
    stars,
    reactions: reactions(heat),
    comments: [
      ...comments(1 + Math.floor(Math.random() * 2)),
      ...(Math.random() < 0.6
        ? [
            {
              author: "Corner Deli",
              text: pick(DELIVERY_FACEBOOK_REPLIES),
              page: true,
            },
          ]
        : []),
    ],
  });
  const delivered = shuffle(log.filter((h) => h.state === "delivered")),
    missed = shuffle(log.filter((h) => h.state === "missed")),
    sampled = shuffle(log.filter((h) => h.state === "sampled")),
    feed: FacebookPost[] = [];
  if (shiftCleared)
    feed.push({
      id: ++id,
      author: "Corner Deli",
      page: true,
      // Even a flawless shift gets a ridiculous complaint pinned to the page.
      text: `Shift complete! ${pick(DELIVERY_ROUTE_SUCCESSES)} Pinned complaint of the day: ${Math.random() < 0.6 ? randomComplaint() : pick(DELIVERY_COMPLAINTS)}`,
      reactions: reactions(0.6),
      comments: comments(1),
    });
  if (!missed.length && delivered.length)
    feed.push(post(pick(DELIVERY_FACEBOOK_PERFECT), null, 1, 4));
  for (const house of delivered.slice(0, missed.length ? 1 : 2))
    feed.push(
      post(
        pick(DELIVERY_FACEBOOK_DELIVERED),
        house,
        1,
        1 + Math.floor(Math.random() * 3),
      ),
    );
  for (const house of missed.slice(0, 2))
    feed.push(post(pick(DELIVERY_FACEBOOK_MISSED), house, 1.4, 1));
  if (sampled[0]) feed.push(post(pick(DELIVERY_FACEBOOK_SAMPLES), sampled[0], 1.2, 1));
  return feed;
}
export function FacebookFeed({ posts }: { posts: FacebookPost[] }) {
  if (!posts.length) return null;
  return (
    <section className="fb-feed" aria-label="Corner Deli Facebook page">
      <header>
        <i className="fb-avatar page">CD</i>
        <div>
          <b>Corner Deli</b>
          <small>Facebook page · Ogdensburg, NY · Visitor posts</small>
        </div>
      </header>
      {posts.map((p) => (
        <article className="fb-post" key={p.id}>
          <div className="fb-byline">
            <i className={`fb-avatar ${p.page ? "page" : ""}`}>
              {p.page ? "CD" : p.author.slice(0, 1)}
            </i>
            <div>
              <b>{p.author}</b>
              <small>
                {p.page ? "Page" : "Just now"}
                {p.stars ? ` · ${"★".repeat(p.stars)}${"☆".repeat(5 - p.stars)}` : ""}
              </small>
            </div>
          </div>
          <p>{p.text}</p>
          <div className="fb-reactions">
            <span>
              👍 {p.reactions.like} · 😆 {p.reactions.haha}
              {p.reactions.angry ? ` · 😡 ${p.reactions.angry}` : ""}
            </span>
            <span>
              {p.comments.length} comment{p.comments.length === 1 ? "" : "s"}
            </span>
          </div>
          {p.comments.map((c, index) => (
            <div className={`fb-comment ${c.page ? "page" : ""}`} key={index}>
              <i className={`fb-avatar small ${c.page ? "page" : ""}`}>
                {c.page ? "CD" : c.author.slice(0, 1)}
              </i>
              <div>
                <b>{c.author}</b>
                {c.page && <small> · Author</small>}
                <span>{c.text}</span>
              </div>
            </div>
          ))}
        </article>
      ))}
      {DELIVERY_FACEBOOK_URL && (
        <a
          className="fb-real-link"
          href={DELIVERY_FACEBOOK_URL}
          target="_blank"
          rel="noreferrer"
        >
          See the real Corner Deli page →
        </a>
      )}
    </section>
  );
}
