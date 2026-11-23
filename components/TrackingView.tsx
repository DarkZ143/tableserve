"use client";

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { doc, onSnapshot } from "firebase/firestore";
import { ArrowLeft, ArrowRight, Check, CircleHelp, Clock3, Copy } from "lucide-react";
import { runFirebaseAction } from "@/lib/firebase-actions";
import { BrandMark } from "@/components/BrandMark";
import { errorMessage, humanizeStatus, money } from "@/lib/format";
import { firebaseConfigured, getFirebase } from "@/lib/firebase";
import type { OrderStatus, PublicTracking } from "@/lib/types";

const statusSteps: OrderStatus[] = ["queued", "accepted", "preparing", "ready", "served"];

type LookupResult = { restaurantId: string; trackingId: string; tracking: PublicTracking };

export default function TrackingView({ ticketId: initialTicket, justPlaced = false }: { ticketId?: string; justPlaced?: boolean }) {
  const [ticketInput, setTicketInput] = useState(initialTicket ?? "");
  const [ticketId, setTicketId] = useState(initialTicket?.toUpperCase() ?? "");
  const [tracking, setTracking] = useState<PublicTracking | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(Boolean(initialTicket && firebaseConfigured));
  const [copied, setCopied] = useState(false);
  const [lookupRevision, setLookupRevision] = useState(0);
  const [trackingRestaurantId, setTrackingRestaurantId] = useState("");
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [feedbackError, setFeedbackError] = useState("");
  const [reportMode, setReportMode] = useState(false);
  const [issueDetails, setIssueDetails] = useState("");
  const configError = Boolean(ticketId && !firebaseConfigured);

  useEffect(() => {
    if (!ticketId || !firebaseConfigured) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    runFirebaseAction<{ ticketId: string }, LookupResult>("lookupTicket", { ticketId })
      .then((result) => {
        if (cancelled) return;
        setTracking(result.tracking);
        setTrackingRestaurantId(result.restaurantId);
        stop = onSnapshot(doc(getFirebase().db, "restaurants", result.restaurantId, "publicTracking", result.trackingId), (snapshot) => {
          if (snapshot.exists()) {
            const data = snapshot.data();
            setTracking({
              ticketId: String(data.ticketId),
              tableNumber: String(data.tableNumber),
              status: data.status as OrderStatus,
              paymentTiming: data.paymentTiming === "pay_after_serve" ? "pay_after_serve" : "prepaid",
              paymentStatus: data.paymentStatus,
              paymentMethod: data.paymentMethod,
              items: Array.isArray(data.items) ? data.items.map((item: { name?: unknown; quantity?: unknown; lineTotalPaise?: unknown; selections?: unknown }) => ({ name: String(item.name ?? "Item"), quantity: Number(item.quantity ?? 0), lineTotalPaise: Number(item.lineTotalPaise ?? 0), selections: Array.isArray(item.selections) ? item.selections.map(String) : [] })) : [],
              subtotalPaise: typeof data.subtotalPaise === "number" ? data.subtotalPaise : undefined,
              taxPaise: typeof data.taxPaise === "number" ? data.taxPaise : undefined,
              serviceFeePaise: typeof data.serviceFeePaise === "number" ? data.serviceFeePaise : undefined,
              totalAmountPaise: typeof data.totalAmountPaise === "number" ? data.totalAmountPaise : undefined,
              estimatedMinutes: typeof data.estimatedMinutes === "number" ? data.estimatedMinutes : null,
              expectedReadyAtMs: data.expectedReadyAt?.toMillis?.() ?? null,
              statusEvents: Array.isArray(data.statusEvents) ? data.statusEvents.map((event: { status: OrderStatus; at?: { toMillis?: () => number } }) => ({ status: event.status, atMs: event.at?.toMillis?.() ?? null })) : [],
              customerServedResponse: data.customerServedResponse && ["yes", "no"].includes(String(data.customerServedResponse.response))
                ? { response: data.customerServedResponse.response, details: String(data.customerServedResponse.details ?? ""), atMs: data.customerServedResponse.createdAt?.toMillis?.() ?? null }
                : undefined,
            });
          }
          setLoading(false);
        }, (listenerError) => { setError(listenerError.message); setLoading(false); });
      })
      .catch((lookupError: unknown) => { if (!cancelled) setError(errorMessage(lookupError)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; stop?.(); };
  }, [ticketId, lookupRevision]);

  async function submitTicket(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = ticketInput.trim().toUpperCase();
    if (normalized) { setTracking(null); setTrackingRestaurantId(""); setError(""); setFeedbackError(""); setReportMode(false); setIssueDetails(""); setLoading(firebaseConfigured); setTicketId(normalized); setLookupRevision((current) => current + 1); }
  }

  async function submitServedFeedback(response: "yes" | "no", details = "") {
    if (!tracking || !trackingRestaurantId || feedbackBusy || tracking.customerServedResponse) return;
    setFeedbackBusy(true);
    setFeedbackError("");
    try {
      const result = await runFirebaseAction<{ ticketId: string; restaurantId: string; response: "yes" | "no"; details?: string }, { response: "yes" | "no" }>("submitServedFeedback", {
        ticketId: tracking.ticketId,
        restaurantId: trackingRestaurantId,
        response,
        details,
      });
      setTracking((current) => current ? { ...current, customerServedResponse: { response: result.response, details, atMs: Date.now() } } : current);
    } catch (feedbackSubmitError) {
      setFeedbackError(errorMessage(feedbackSubmitError));
    } finally {
      setFeedbackBusy(false);
    }
  }

  async function copyTicket() {
    if (!tracking) return;
    await navigator.clipboard.writeText(tracking.ticketId);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  const currentIndex = tracking ? statusSteps.indexOf(tracking.status) : -1;
  const expected = tracking?.expectedReadyAtMs ? new Date(tracking.expectedReadyAtMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
  const statusTime = (status: OrderStatus) => {
    const event = tracking?.statusEvents.find((entry) => entry.status === status && entry.atMs);
    return event?.atMs ? new Date(event.atMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  };

  return <main className="guest-shell">
    <div className="tracking-wrap">
      <header className="tracking-head"><Link className="brand" to="/"><BrandMark /><span><span className="brand-name">TableServe</span><span className="brand-sub">Live order tracking</span></span></Link><Link className="btn btn-quiet btn-small" to="/"><ArrowLeft size={14} /> Menu</Link></header>
      {!tracking && <>
        {justPlaced && <><div className="success-mark"><Check size={34} /></div><div className="eyebrow" style={{ textAlign: "center" }}>Order received</div><h1 className="success-title">Order sent to restaurant</h1><p className="success-copy">Your order is being confirmed. Its payment timing and live preparation estimate will appear here shortly.</p></>}
        <section className="panel" style={{ marginTop: 20 }}>
          <div className="eyebrow">Track a ticket</div><h2 style={{ margin: "6px 0", fontSize: 24 }}>Your order, at a glance.</h2><p className="muted" style={{ marginTop: 0 }}>Enter the Ticket ID shown after you placed the order.</p>
          <form className="ticket-lookup" onSubmit={submitTicket}><input className="field" value={ticketInput} onChange={(event) => setTicketInput(event.target.value)} required placeholder="TS-…" aria-label="Ticket ID" /><button className="btn btn-primary" type="submit">Track <ArrowRight size={15} /></button></form>
          {configError && <div className="notice error">Firebase is not configured. Add the NEXT_PUBLIC_FIREBASE_* settings to load order tracking.</div>}
          {error && <div className="notice error">{error}</div>}
          {loading && <div className="loading">Looking up this ticket…</div>}
        </section>
      </>}

      {tracking && <>
        {justPlaced && <><div className="success-mark"><Check size={34} /></div><div className="eyebrow" style={{ textAlign: "center" }}>{tracking.paymentMethod === "upi" ? "UPI payment submitted" : "Pay at restaurant"}</div><h1 className="success-title">Order sent to restaurant</h1><p className="success-copy">{tracking.paymentMethod === "upi" ? "Your order is in the live queue. The restaurant will confirm your UPI payment after checking its account." : "Your order is in the restaurant’s live queue. Pay the bill to restaurant staff after it reaches your table."}</p></>}
        {tracking.status === "served" && <section className="served-prompt" aria-live="polite">
          <div className="eyebrow">Your order was marked served</div>
          <h1>Enjoy your meal!</h1>
          {tracking.customerServedResponse ? <><p>{tracking.customerServedResponse.response === "yes" ? "Thanks for confirming. Enjoy your meal!" : "Thanks for letting us know. Your report is saved for the restaurant team, and they’ll resolve this quickly."}</p>{tracking.customerServedResponse.details && <p className="served-feedback-details">Your note: {tracking.customerServedResponse.details}</p>}</> : <>
            <p>Has your order reached you?</p>
            <div className="served-prompt-actions"><button className="btn btn-primary" type="button" disabled={feedbackBusy} onClick={() => void submitServedFeedback("yes")}>{feedbackBusy ? "Sending…" : "Yes, served"}</button><button className="btn btn-soft" type="button" disabled={feedbackBusy} onClick={() => setReportMode(true)}>No, report an issue</button></div>
            {reportMode && <div className="served-report-form"><label className="field-label">What went wrong? <small className="muted">Optional · up to 500 characters</small><textarea className="field" rows={3} maxLength={500} value={issueDetails} onChange={(event) => setIssueDetails(event.target.value)} placeholder="Tell the restaurant what is missing or not served." /></label><div className="served-prompt-actions"><button className="btn btn-quiet btn-small" type="button" disabled={feedbackBusy} onClick={() => setReportMode(false)}>Cancel</button><button className="btn btn-primary btn-small" type="button" disabled={feedbackBusy} onClick={() => void submitServedFeedback("no", issueDetails.trim())}>{feedbackBusy ? "Sending…" : "Send report"}</button></div></div>}
          </>}
          {feedbackError && <div className="notice error" role="alert">{feedbackError}</div>}
        </section>}
        <section className="panel ticket-card">
          <div className="ticket-top"><div><div className="eyebrow">Ticket · Table {tracking.tableNumber}</div><div className="ticket-id">{tracking.ticketId}</div></div><button className="btn btn-soft btn-small" onClick={copyTicket}><Copy size={14} /> {copied ? "Copied" : "Copy ID"}</button></div>
          <div className="track-status-card">
            <div className="eyebrow">Current status</div><h2>{tracking.status === "queued" ? "In Queue" : humanizeStatus(tracking.status)}</h2>
            {tracking.paymentStatus === "pending" && tracking.paymentMethod === "upi" && <div className="notice error" style={{ marginBottom: 12 }}>UPI payment is waiting for restaurant confirmation. Contact staff if they haven’t confirmed it yet.</div>}
            {tracking.paymentTiming === "pay_after_serve" && <div className={`notice ${tracking.paymentStatus === "paid" ? "" : "error"}`} style={{ marginBottom: 12 }}>{tracking.paymentStatus === "paid" ? "Payment recorded. Thank you!" : "Bill due · Please pay the restaurant after serving."}</div>}
            {tracking.paymentMethod === "upi" && tracking.paymentStatus === "paid" && <div className="notice" style={{ marginBottom: 12 }}>UPI payment confirmed by the restaurant. Thank you!</div>}
            {tracking.status === "cancelled" ? <div className="notice error">This order was cancelled by the restaurant.</div> : <div className="eta-box"><div><small className="muted">Estimated preparation</small><div className="eta-value">{tracking.estimatedMinutes ? `${tracking.estimatedMinutes} min` : "Waiting"}</div><small className="muted">{expected ? `Expected around ${expected}` : "Waiting for restaurant confirmation"}</small></div><Clock3 size={22} color="#850d32" /></div>}
          </div>
          {tracking.status === "cancelled" ? <p className="muted" style={{ margin: "15px 0 0" }}>Contact the restaurant team if you need help with this order.</p> : <ol className="timeline">
            {statusSteps.map((status, index) => <li className={index <= currentIndex ? "done" : ""} key={status}><strong>{status === "queued" ? "In Queue" : humanizeStatus(status)}</strong><small>{statusTime(status) || (index === 0 ? "Order received" : index > currentIndex ? "Waiting for update" : "Updated by the restaurant")}</small></li>)}
          </ol>}
          {error && <div className="notice error" style={{ marginTop: 12 }}>{error}</div>}
        </section>
        {tracking.items?.length ? <section className="panel tracking-order-details">
          <div className="eyebrow">Order details</div><h2>What’s on this ticket</h2>
          <div className="tracking-order-items">{tracking.items.map((item, index) => <div className="tracking-order-item" key={`${item.name}-${index}`}><div><strong>{item.quantity} × {item.name}</strong>{item.selections?.length ? <small>{item.selections.join(" · ")}</small> : null}</div><strong>{money(item.lineTotalPaise)}</strong></div>)}</div>
          <div className="tracking-order-totals">{typeof tracking.subtotalPaise === "number" && <div><span>Subtotal</span><span>{money(tracking.subtotalPaise)}</span></div>}{typeof tracking.taxPaise === "number" && <div><span>Tax</span><span>{money(tracking.taxPaise)}</span></div>}{typeof tracking.serviceFeePaise === "number" && tracking.serviceFeePaise > 0 && <div><span>Service fee</span><span>{money(tracking.serviceFeePaise)}</span></div>}{typeof tracking.totalAmountPaise === "number" && <div className="tracking-order-total"><strong>Total</strong><strong>{money(tracking.totalAmountPaise)}</strong></div>}</div>
        </section> : null}
        {!justPlaced && <form className="ticket-lookup" onSubmit={submitTicket}><input className="field" value={ticketInput} onChange={(event) => setTicketInput(event.target.value)} placeholder="Track another ticket" aria-label="Ticket ID" /><button className="btn btn-soft" type="submit">Look up</button></form>}
        {loading && <div className="loading">Syncing order status…</div>}
      </>}
      <footer className="guest-footer"><CircleHelp size={15} style={{ verticalAlign: "middle", marginRight: 6 }} />Updates shown here come from the restaurant’s live order record.</footer>
    </div>
  </main>;
}
