import type { CSSProperties } from "react";

const vars = (style: Record<string, string | number>) => style as CSSProperties;

/** Falling leaves, snow, or bats and fog for the holiday seasons (styles in menu-board.css). */
export default function SeasonFx({ season }: { season: string }) {
  if (season === "halloween") {
    return (
      <div className="mbFx">
        {[0, 1, 2].map((i) => <span key={`f${i}`} className="fog" style={{ left: `${i * 30}%`, animationDuration: `${26 + i * 9}s`, animationDelay: `${-i * 7}s` }} />)}
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <span key={`b${i}`} className="bat" style={vars({ left: 0, top: `${80 + ((i * 137) % 700)}px`, animationDuration: `${11 + ((i * 5) % 9)}s`, animationDelay: `${-((i * 4) % 13)}s`, "--sc": 0.5 + (i % 3) * 0.3 })} />
        ))}
      </div>
    );
  }
  const kind = season === "thanksgiving" ? "leaf" : season === "christmas" ? "snow" : "";
  if (!kind) return null;
  const leafColors = ["#e8622a", "#f4b43a", "#b4421c", "#d98b2b"];
  return (
    <div className="mbFx">
      {Array.from({ length: 18 }, (_, i) => (
        <span key={i} className={kind} style={vars({
          left: `${(i * 37) % 100}%`, animationDuration: `${9 + ((i * 7) % 8)}s`, animationDelay: `${-((i * 13) % 17)}s`,
          "--dx": `${((i % 5) - 2) * 90}px`, "--rot": `${(i % 2 ? 1 : -1) * (180 + i * 20)}deg`,
          ...(kind === "leaf" ? { background: leafColors[i % 4] } : { transform: `scale(${0.6 + (i % 4) * 0.25})` }),
        })} />
      ))}
    </div>
  );
}
