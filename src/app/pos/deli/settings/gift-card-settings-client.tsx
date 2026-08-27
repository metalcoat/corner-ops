"use client";
import { useState } from "react";
const cents = (value: string) => Math.round(Number(value) * 100),
  key = () => crypto.randomUUID(),
  money = (value: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(value / 100);
export default function GiftCardSettingsClient() {
  const [cardNumber, setCardNumber] = useState(""),
    [amount, setAmount] = useState(""),
    [reason, setReason] = useState(""),
    [result, setResult] = useState<any>(null),
    [message, setMessage] = useState(""),
    [report, setReport] = useState<any>(null),
    [importText, setImportText] = useState(""),
    [importResult, setImportResult] = useState<any>(null),
    [importBusy, setImportBusy] = useState(false);
  async function call(
    method: string,
    body?: Record<string, unknown>,
    query = "",
  ) {
    setMessage("");
    const response = await fetch(`/api/ordering/gift-cards${query}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body
          ? JSON.stringify({ business: "Corner Deli", ...body })
          : undefined,
      }),
      data = await response.json();
    if (!response.ok) {
      setMessage(data.error || "Operation failed.");
      return null;
    }
    setResult(data);
    return data;
  }
  async function lookup() {
    await call(
      "GET",
      undefined,
      `?business=Corner%20Deli&cardNumber=${encodeURIComponent(cardNumber)}`,
    );
  }
  async function mutate(action: string) {
    const data = await call("PATCH", {
      action,
      cardNumber,
      amountCents: cents(amount),
      deltaCents: cents(amount),
      reason,
      operationKey: key(),
    });
    if (data) setMessage(`${action} completed.`);
  }
  async function loadReport() {
    const response = await fetch(
        "/api/ordering/gift-cards/report?business=Corner%20Deli",
      ),
      data = await response.json();
    if (response.ok) setReport(data);
    else setMessage(data.error);
  }
  function importRows() {
    return importText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter(
        (line, index) => !(index === 0 && /source.*card.*balance/i.test(line)),
      )
      .map((line) => {
        const [sourceReference, number, balance] = line
          .split(",")
          .map((value) => value.trim());
        return {
          sourceReference,
          cardNumber: number,
          balanceCents: cents(balance),
        };
      });
  }
  async function runImport(dryRun: boolean) {
    setImportBusy(true);
    setMessage("");
    const rows = importRows();
    try {
      const response = await fetch("/api/ordering/gift-cards/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          business: "Corner Deli",
          batchKey: `gift-card-ui-${key()}`,
          dryRun,
          rows,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Import failed.");
      setImportResult(data);
      setMessage(
        dryRun
          ? "Preview complete. Review the counts, then import."
          : `${data.imported} gift cards imported.`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setImportBusy(false);
    }
  }
  return (
    <section className="giftCardSettings">
      <h2>Gift cards</h2>
      <p>
        Activate, load, inspect, and manage durable gift-card accounts. Full
        numbers are never displayed after entry. Gift cards do not require a
        PIN.
      </p>
      <div>
        <label>
          Card number
          <input
            value={cardNumber}
            onChange={(e) => setCardNumber(e.target.value)}
            autoComplete="off"
          />
        </label>
        <label>
          Amount / adjustment (+ or −)
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
          />
        </label>
        <label>
          Manager reason
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      </div>
      <button onClick={() => void lookup()}>LOOK UP</button>
      <button
        onClick={async () => {
          const data = await call("POST", {
            initialLoadCents: cents(amount),
            operationKey: key(),
          });
          if (data) {
            setCardNumber(data.cardNumber || "");
            setMessage(
              "Card activated. Record the number now; it will only be masked later.",
            );
          }
        }}
      >
        ACTIVATE + INITIAL LOAD
      </button>
      <button onClick={() => void mutate("reload")}>RELOAD</button>
      <button onClick={() => void mutate("adjust")}>MANAGER ADJUST</button>
      <button onClick={() => void mutate("replace")}>
        REPLACE / DEACTIVATE
      </button>
      {result?.card && (
        <article>
          <strong>{result.card.masked_number}</strong>
          <span>
            {money(Number(result.card.current_balance_cents))} ·{" "}
            {result.card.status}
          </span>
          {result.history?.map((row: any) => (
            <small key={row.id}>
              {row.entry_type} · {money(Number(row.delta_balance_cents))} ·{" "}
              {new Date(row.created_at).toLocaleString()}
            </small>
          ))}
        </article>
      )}
      {result?.cardNumber && (
        <p role="status">
          New card: <strong>{result.cardNumber}</strong> ·{" "}
          {money(Number(result.balanceCents))}
        </p>
      )}
      <h3>Outstanding balance report</h3>
      <button onClick={() => void loadReport()}>REFRESH REPORT</button>
      {report && (
        <p>
          {money(Number(report.summary.outstanding_balance_cents))} outstanding
          across {report.summary.active_card_count} active accounts.
        </p>
      )}
      <h3>Import existing gift cards</h3>
      <p>
        CSV columns: source reference, card number, balance in dollars. A header
        row is optional. Preview first; duplicates are skipped.
      </p>
      <label>
        Choose CSV file
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            void file.text().then((text) => {
              setImportText(text);
              setImportResult(null);
            });
          }}
        />
      </label>
      <textarea
        value={importText}
        onChange={(e) => {
          setImportText(e.target.value);
          setImportResult(null);
        }}
        placeholder={
          "source_reference,card_number,balance\nlegacy-001,123456789012,25.00"
        }
      />
      <button
        disabled={importBusy || !importText.trim()}
        onClick={() => void runImport(true)}
      >
        PREVIEW IMPORT
      </button>
      <button
        disabled={importBusy || !importResult?.ready}
        onClick={() => void runImport(false)}
      >
        IMPORT {importResult?.ready || 0} READY CARDS
      </button>
      {importResult?.rows && (
        <p>
          {importResult.total} rows · {importResult.ready} ready ·{" "}
          {importResult.imported} imported · {importResult.duplicates}{" "}
          duplicates · {importResult.invalid} invalid
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <style jsx>{`
        section {
          padding: 20px;
          border: 1px solid #d7d1c4;
          border-radius: 12px;
          margin-top: 18px;
        }
        section > div {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
        }
        label,
        article {
          display: grid;
          gap: 4px;
        }
        button {
          margin: 8px 8px 0 0;
        }
        textarea {
          width: 100%;
          min-height: 80px;
        }
      `}</style>
    </section>
  );
}
