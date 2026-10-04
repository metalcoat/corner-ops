// The Corner Deli Facebook page parody shown between shifts.
import {
  DELIVERY_COMPLAINTS,
  DELIVERY_FACEBOOK_DELIVERED,
  DELIVERY_FACEBOOK_URL,
  DELIVERY_ROUTE_SUCCESSES,
} from "@/lib/delivery-boy/config";
import {
  FB_COMMENTS,
  FB_DELIVERED,
  FB_MISSED,
  FB_PEOPLE,
  FB_PERFECT,
  FB_REPLIES,
  FB_SAMPLES,
  type FbReplyKind,
} from "@/lib/delivery-boy/facebook-content";
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
const shuffle = <T,>(items: T[]) => {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
};
const fill = (text: string, values: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
// Remember what was shown recently so lines don't repeat shift after shift.
const recent = new Map<readonly string[], string[]>();
function fresh(pool: readonly string[], memory = Math.floor(pool.length * 0.7)) {
  const seen = recent.get(pool) ?? [];
  const options = pool.filter((line) => !seen.includes(line));
  const line = (options.length ? options : pool)[Math.floor(Math.random() * (options.length || pool.length))];
  recent.set(pool, [...seen, line].slice(-memory));
  return line;
}
export const reactions = (heat: number) => ({
  like: Math.floor(Math.random() * 40) + 3,
  haha: Math.floor(Math.random() * 180 * heat) + 12,
  angry: Math.floor(Math.random() * 25 * heat),
});
const DELIVERED_POSTS = [...FB_DELIVERED, ...DELIVERY_FACEBOOK_DELIVERED];
/**
 * The Corner Deli Facebook page after a shift: the page brags, then the
 * customers complain anyway, including the ones whose food landed perfectly.
 * Comments and the deli's replies are addressed to the people in the thread.
 */
export function buildFeed(log: House[], shiftCleared: boolean): FacebookPost[] {
  let id = 0;
  const people = shuffle([...FB_PEOPLE]);
  let next = 0;
  const someone = () => people[next++ % people.length];
  const thread = (author: string, count: number, replies: FbReplyKind | null) => {
    const comments: FacebookPost["comments"] = [];
    let prev = author;
    for (let i = 0; i < count; i++) {
      const commenter = someone();
      comments.push({ author: commenter, text: fill(fresh(FB_COMMENTS), { author, prev }) });
      prev = commenter;
    }
    if (replies && Math.random() < 0.75)
      comments.push({ author: "Corner Deli", text: fill(fresh(FB_REPLIES[replies]), { author }), page: true });
    return comments;
  };
  const post = (
    pool: readonly string[],
    replies: FbReplyKind,
    house: House | null,
    heat: number,
    stars?: number,
  ): FacebookPost => {
    const author = someone();
    return {
      id: ++id,
      author,
      text: fill(fresh(pool), { item: house?.item ?? "sub", address: house?.address ?? "my house" }),
      stars,
      reactions: reactions(heat),
      comments: thread(author, 1 + Math.floor(Math.random() * 3), replies),
    };
  };
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
      text: `Shift complete! ${fresh(DELIVERY_ROUTE_SUCCESSES)} Pinned complaint of the day: ${Math.random() < 0.6 ? randomComplaint() : fresh(DELIVERY_COMPLAINTS)}`,
      reactions: reactions(0.6),
      comments: thread("Corner Deli", 1 + Math.floor(Math.random() * 2), null),
    });
  if (!missed.length && delivered.length) feed.push(post(FB_PERFECT, "delivered", null, 1, 4));
  for (const house of delivered.slice(0, missed.length ? 1 : 2))
    feed.push(post(DELIVERED_POSTS, "delivered", house, 1, 1 + Math.floor(Math.random() * 3)));
  for (const house of missed.slice(0, 2)) feed.push(post(FB_MISSED, "missed", house, 1.4, 1));
  if (sampled[0]) feed.push(post(FB_SAMPLES, "sample", sampled[0], 1.2, 1));
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
