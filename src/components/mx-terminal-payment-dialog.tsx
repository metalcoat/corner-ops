"use client";

import { useEffect, useRef, useState } from "react";

export type MxTerminalSale = {
  orderId: string;
  sessionId: string;
  amountCents: number;
  message: string;
  /** "authorized" resumes at the tip step for a card that was already approved. */
  state?: "pending" | "authorized";
};

type StatusBody = {
  state?: "pending" | "authorized" | "approved" | "declined" | "failed" | "needs_review";
  message?: string;
  checkout?: unknown;
  kitchenWarning?: string;
  error?: string;
};
type Phase = "waiting" | "tip" | "completing" | "declined" | "failed" | "needs_review" | "stopping" | "releasing" | "released";

const POLL_MS = 2000;
/** MX's own guidance is to poll for about two minutes; after that the cashier decides. */
const SLOW_AFTER_MS = 120_000;
const TIP_PERCENTS = [15, 18, 20];
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

async function postTerminal(orderId: string, body: Record<string, unknown>) {
  const response = await fetch(`/api/ordering/orders/${encodeURIComponent(orderId)}/payments/mx-terminal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as StatusBody;
  if (!response.ok) throw new Error(payload.error || "The terminal payment could not be checked.");
  return payload;
}

/**
 * The card goes in first and the tip comes after: the terminal holds the balance, the customer picks a tip here,
 * and the POS charges balance + tip in one go.
 */
export default function MxTerminalPaymentDialog({
  sale,
  onApproved,
  onClose,
}: {
  sale: MxTerminalSale;
  onApproved: (checkout: unknown, kitchenWarning?: string) => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>(sale.state === "authorized" ? "tip" : "waiting");
  const [message, setMessage] = useState(sale.message);
  const [slow, setSlow] = useState(false);
  const [customTip, setCustomTip] = useState("");
  const done = useRef(false);
  const approved = useRef(onApproved);
  approved.current = onApproved;

  /** Applies a server answer; returns true when polling should continue. */
  function apply(result: StatusBody) {
    if (done.current) return false;
    if (result.state === "approved") {
      done.current = true;
      approved.current(result.checkout, result.kitchenWarning);
      return false;
    }
    if (result.state === "authorized") {
      setPhase("tip");
      setMessage(result.message || "");
      return false;
    }
    if (result.state === "declined" || result.state === "failed" || result.state === "needs_review") {
      setPhase(result.state);
      setMessage(result.message || (result.state === "declined" ? "The card was declined." : "The terminal did not complete the sale."));
      return false;
    }
    if (result.message) setMessage(result.message);
    return true;
  }

  useEffect(() => {
    if (phase !== "waiting" && phase !== "completing") return;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined, cancelled = false;
    const poll = async () => {
      let keepGoing = true;
      try {
        const result = await postTerminal(sale.orderId, { action: "status", sessionId: sale.sessionId });
        if (cancelled) return;
        keepGoing = apply(result);
      } catch (error) {
        // The server answers every final state normally, so an error here is a dropped poll, not a failed sale: keep checking.
        if (!cancelled) setMessage(error instanceof Error ? error.message : "Lost contact with MX. Still checking…");
      }
      if (cancelled || !keepGoing) return;
      setSlow(phase === "waiting" && Date.now() - started > SLOW_AFTER_MS);
      timer = setTimeout(poll, POLL_MS);
    };
    timer = setTimeout(poll, POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [phase, sale.orderId, sale.sessionId]);

  async function chooseTip(tipCents: number) {
    if (!Number.isSafeInteger(tipCents) || tipCents < 0) return;
    setPhase("completing");
    setMessage(tipCents ? `Charging ${money(sale.amountCents + tipCents)} with a ${money(tipCents)} tip…` : `Charging ${money(sale.amountCents)}…`);
    try {
      apply(await postTerminal(sale.orderId, { action: "complete", sessionId: sale.sessionId, tipCents }));
    } catch (error) {
      // Declines come back as "authorized"; an error here is a lost answer, so keep checking the charge.
      setMessage(error instanceof Error ? error.message : "Finishing the card payment…");
    }
  }

  async function releaseCard() {
    setPhase("releasing");
    try {
      await postTerminal(sale.orderId, { action: "void", sessionId: sale.sessionId });
      setPhase("released");
      setMessage("The card was released without charging it.");
    } catch (error) {
      setPhase("tip");
      setMessage(error instanceof Error ? error.message : "The card could not be released.");
    }
  }

  async function stopWaiting() {
    setPhase("stopping");
    try {
      await postTerminal(sale.orderId, { action: "abandon", sessionId: sale.sessionId });
      // One last look, in case the card went through while the cashier was pressing the button.
      const last = await postTerminal(sale.orderId, { action: "status", sessionId: sale.sessionId });
      if (last.state === "authorized" || last.state === "approved" || last.state === "needs_review") {
        apply(last);
        return;
      }
    } catch {}
    done.current = true;
    onClose();
  }

  const waiting = phase === "waiting" || phase === "stopping";
  const busy = phase === "completing" || phase === "releasing";
  const final = phase === "declined" || phase === "failed" || phase === "needs_review" || phase === "released";
  return (
    <div className="mxPaymentBackdrop" role="presentation">
      <section className="mxPaymentDialog mxTerminalDialog" role="dialog" aria-modal="true" aria-labelledby="mx-terminal-title">
        <h2 id="mx-terminal-title">{phase === "tip" ? "Card approved: add a tip?" : "Card terminal"}</h2>
        <strong>{money(sale.amountCents)}</strong>
        {waiting && (
          <>
            <div className="mxTerminalWaiting" aria-live="polite">
              <span className="mxTerminalPulse" aria-hidden="true" />
              <span>{message || "The customer can tap, insert, or swipe now."}</span>
            </div>
            {slow && <small>No answer from the terminal yet. If the customer walked away or the terminal shows an error, cancel it on the terminal and stop waiting.</small>}
            <small>Paying another way? Press the red X on the terminal first, then STOP WAITING. The POS cannot cancel the sale on the terminal, and it will not take cash or another card while the terminal could still charge this one.</small>
          </>
        )}
        {phase === "tip" && (
          <div className="mxTerminalTip">
            {/* The server's normal "Card approved…" line is the heading here; only problems (a declined tip) are shown. */}
            {message && !message.startsWith("Card approved") && <p role="alert">{message}</p>}
            <div className="posTipChoices">
              {TIP_PERCENTS.map((percent) => {
                const tip = Math.round((sale.amountCents * percent) / 100);
                return (
                  <button type="button" key={percent} onClick={() => void chooseTip(tip)}>
                    {percent}%<span>{money(tip)}</span>
                  </button>
                );
              })}
              <button type="button" onClick={() => void chooseTip(0)}>NO TIP</button>
            </div>
            <label>
              Custom tip
              <input type="number" inputMode="decimal" min="0" step="0.01" value={customTip} onChange={(event) => setCustomTip(event.target.value)} />
            </label>
            <button type="button" disabled={!customTip || Number(customTip) < 0} onClick={() => void chooseTip(Math.round(Number(customTip) * 100))}>
              ADD CUSTOM TIP
            </button>
          </div>
        )}
        {busy && (
          <div className="mxTerminalWaiting" aria-live="polite">
            <span className="mxTerminalPulse" aria-hidden="true" />
            <span>{phase === "releasing" ? "Releasing the card…" : message}</span>
          </div>
        )}
        {final && (
          <>
            <p role={phase === "released" ? "status" : "alert"}>{message}</p>
            {phase === "needs_review" && <small>Do not charge this order again. A manager can find this charge under POS settings → Hardware.</small>}
          </>
        )}
        <footer>
          {waiting && (
            <button type="button" disabled={phase === "stopping"} onClick={() => void stopWaiting()}>
              {phase === "stopping" ? "STOPPING…" : "STOP WAITING"}
            </button>
          )}
          {phase === "tip" && <button type="button" onClick={() => void releaseCard()}>RELEASE CARD (DON&apos;T CHARGE)</button>}
          {final && <button type="button" onClick={onClose}>CLOSE</button>}
        </footer>
      </section>
    </div>
  );
}
