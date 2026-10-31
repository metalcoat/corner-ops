import type { ReactNode } from "react";
import "./policy-page.css";

/**
 * Shared frame for the public policy pages (privacy, terms, SMS help, refunds) so they match the
 * online ordering page: green header with the Corner Deli logo, cream page, same type.
 */
export default function PolicyPage({ children }: { children: ReactNode }) {
  return (
    <div className="policyPage">
      <header className="policyHeader">
        <a className="policyBrand" href="/order">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/corner-deli-logo.png" alt="" />
          <strong>Corner Deli</strong>
        </a>
        <a className="policyBack" href="/order">Back to ordering</a>
      </header>
      <main className="policyBody">{children}</main>
      <footer className="policyFooter">
        <strong>Corner Deli (Mike&apos;s Corner Deli, LLC)</strong>
        <span>828 Morris St · Ogdensburg, NY 13669</span>
        <span>(315) 393-2271</span>
        <a href="mailto:bills@ordercornerdeli.com">bills@ordercornerdeli.com</a>
        <a href="/refund-policy">Refund &amp; Cancellation</a>
        <a href="/delivery-policy">Delivery &amp; Pickup</a>
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
      </footer>
    </div>
  );
}
