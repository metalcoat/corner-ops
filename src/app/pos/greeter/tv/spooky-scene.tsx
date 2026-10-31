/** The greeter's Halloween night (styles in greeter-tv.css): moon, graveyard, jack-o'-lanterns and friendly ghosts. */
export default function SpookyScene() {
  return (
    <div className="gtSpooky" aria-hidden>
      <i className="gtMoon" />
      <svg className="gtGraveyard" viewBox="0 0 1920 300" preserveAspectRatio="none">
        <path d="M0 300V236q70-26 150-10t170-8q40-8 90 6V146l-24 12 56-78 56 78-24-12v50h52v-92l-22 14 58-92 58 92-22-14v84h40V136l-20 12 48-66 48 66-20-12v94q120-30 250-8t200-10q40-14 70-6v-52h-14l34-34 34 34h-14v62q80 16 150-2 44-46 34-96-30-6-52-30 34 10 58 2-4-34-30-52 34 8 50 44 26-36 62-40-30 22-42 58 30 14 66 2-26 24-66 26-10 44 12 74 90 22 158-6L1920 240V300z" />
        <path d="M250 300v-58q0-34 34-34t34 34v58zm350 0v-44q0-26 26-26t26 26v44zm760 0v-50q0-30 30-30t30 30v50zm300 0v-40q0-24 24-24t24 24v40z" />
      </svg>
      <svg className="gtGhost g1" viewBox="0 0 100 130"><Ghost /></svg>
      <svg className="gtGhost g2" viewBox="0 0 100 130"><Ghost /></svg>
      <svg className="gtGhost g3" viewBox="0 0 100 130"><Ghost /></svg>
      <svg className="gtPumpkin p1" viewBox="0 0 200 170"><Pumpkin /></svg>
      <svg className="gtPumpkin p2" viewBox="0 0 200 170"><Pumpkin /></svg>
    </div>
  );
}

function Ghost() {
  return (
    <>
      <path fill="#f4efff" d="M50 4C22 4 8 26 8 54v70l14-12 14 14 14-14 14 14 14-14 14 12V54C92 26 78 4 50 4z" />
      <ellipse fill="#180a24" cx="36" cy="48" rx="7" ry="10" />
      <ellipse fill="#180a24" cx="64" cy="48" rx="7" ry="10" />
      <ellipse fill="#180a24" cx="50" cy="72" rx="9" ry="7" />
    </>
  );
}

function Pumpkin() {
  return (
    <>
      <path fill="#4d7a2c" d="M92 34c-2-16 4-26 18-32l8 10c-8 4-12 12-10 22z" />
      <ellipse fill="#c9500e" cx="42" cy="100" rx="40" ry="62" />
      <ellipse fill="#c9500e" cx="158" cy="100" rx="40" ry="62" />
      <ellipse fill="#f0761a" cx="70" cy="100" rx="42" ry="68" />
      <ellipse fill="#f0761a" cx="130" cy="100" rx="42" ry="68" />
      <ellipse fill="#ff8d2e" cx="100" cy="100" rx="36" ry="70" />
      <path className="gtFace" fill="#ffe27a" d="M50 84l24-24 18 24zm100 0-24-24-18 24zM90 108h20l-10-18zM44 118q18 10 30 8l6 14 14-12h12l14 12 6-14q12 2 30-8-10 34-56 36t-56-36z" />
    </>
  );
}
