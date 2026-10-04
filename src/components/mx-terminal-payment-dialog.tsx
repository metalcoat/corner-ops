"use client";

import { useEffect, useRef, useState } from "react";

export type MxTerminalSale = {
  orderId: string;
  sessionId: string;
  amountCents: number;
  message: string;
};

type StatusBody = {
  state?: "pending" | "approved" | "declined" | "failed";
  message?: string;
  checkout?: unknown;
  error?: string;
};

const POLL_MS = 2000;
/** MX's own guidance is to poll for about two minutes; after that the cashier decides. */
const SLOW_AFTER_MS = 120_000;

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

export default function MxTerminalPaymentDialog({
  sale,
  onApproved,
  onClose,
}: {
  sale: MxTerminalSale;
  onApproved: (checkout: unknown) => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<"waiting" | "declined" | "failed" | "stopping">("waiting");
  const [message, setMessage] = useState(sale.message);
  const [slow, setSlow] = useState(false);
  const done = useRef(false);
  const approved = useRef(onApproved);
  approved.current = onApproved;

  useEffect(() => {
    if (phase !== "waiting") return;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined, cancelled = false;
    const poll = async () => {
      try {
        const result = await postTerminal(sale.orderId, { action: "status", sessionId: sale.sessionId });
        if (cancelled || done.current) return;
        if (result.state === "approved") {
          done.current = true;
          approved.current(result.checkout);
          return;
        }
        if (result.state === "declined" || result.state === "failed") {
          setPhase(result.state);
          setMessage(result.message || (result.state === "declined" ? "The card was declined." : "The terminal did not complete the sale."));
          return;
        }
        if (result.message) setMessage(result.message);
      } catch (error) {
        // A dropped poll is not a failed sale; keep checking and show why.
        if (!cancelled) setMessage(error instanceof Error ? error.message : "Lost contact with MX. Still checking…");
      }
      if (cancelled) return;
      setSlow(Date.now() - started > SLOW_AFTER_MS);
      timer = setTimeout(poll, POLL_MS);
    };
    timer = setTimeout(poll, POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [phase, sale.orderId, sale.sessionId]);

  async function stopWaiting() {
    setPhase("stopping");
    try {
      await postTerminal(sale.orderId, { action: "abandon", sessionId: sale.sessionId });
      // One last look, in case the card went through while the cashier was pressing the button.
      const last = await postTerminal(sale.orderId, { action: "status", sessionId: sale.sessionId });
      if (last.state === "approved" && !done.current) {
        done.current = true;
        approved.current(last.checkout);
        return;
      }
    } catch {}
    done.current = true;
    onClose();
  }

  const dollars = `$${(sale.amountCents / 100).toFixed(2)}`;
  return (
    <div className="mxPaymentBackdrop" role="presentation">
      <section className="mxPaymentDialog mxTerminalDialog" role="dialog" aria-modal="true" aria-labelledby="mx-terminal-title">
        <h2 id="mx-terminal-title">Card terminal</h2>
        <strong>{dollars}</strong>
        {phase === "waiting" || phase === "stopping" ? (
          <>
            <div className="mxTerminalWaiting" aria-live="polite">
              <span className="mxTerminalPulse" aria-hidden="true" />
              <span>{message || "Ask the customer to tap, insert, or swipe on the terminal."}</span>
            </div>
            {slow && <small>No answer from the terminal yet. If the customer walked away or the terminal shows an error, stop waiting and cancel on the terminal too.</small>}
            <small>The POS cannot cancel the sale on the terminal. If you stop waiting, press the red X on the terminal as well. A card that still goes through is added to this order the next time you charge it.</small>
          </>
        ) : (
          <p role="alert">{message}</p>
        )}
        <footer>
          {phase === "waiting" || phase === "stopping" ? (
            <button type="button" disabled={phase === "stopping"} onClick={() => void stopWaiting()}>
              {phase === "stopping" ? "STOPPING…" : "STOP WAITING"}
            </button>
          ) : (
            <button type="button" onClick={onClose}>CLOSE</button>
          )}
        </footer>
      </section>
    </div>
  );
}
