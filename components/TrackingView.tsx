"use client";

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { doc, onSnapshot } from "firebase/firestore";
import { ArrowLeft, ArrowRight, Check, CircleHelp, Clock3, Copy } from "lucide-react";
import { runFirebaseAction } from "@/lib/firebase-actions";
import { BrandMark } from "@/components/BrandMark";
import { errorMessage, humanizeStatus } from "@/lib/format";
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
  const configError = Boolean(ticketId && !firebaseConfigured);

  useEffect(() => {
    if (!ticketId || !firebaseConfigured) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    runFirebaseAction<{ ticketId: string }, LookupResult>("lookupTicket", { ticketId })
      .then((result) => {
        if (cancelled) return;
        setTracking(result.tracking);
        stop = onSnapshot(doc(getFirebase().db, "restaurants", result.restaurantId, "publicTracking", result.trackingId), (snapshot) => {
          if (snapshot.exists()) {
            const data = snapshot.data();
            setTracking({
              ticketId: String(data.ticketId),
              tableNumber: String(data.tableNumber),
              status: data.status as OrderStatus,
              estimatedMinutes: typeof data.estimatedMinutes === "number" ? data.estimatedMinutes : null,
              expectedReadyAtMs: data.expectedReadyAt?.toMillis?.() ?? null,
              statusEvents: Array.isArray(data.statusEvents) ? data.statusEvents.map((event: { status: OrderStatus; at?: { toMillis?: () => number } }) => ({ status: event.status, atMs: event.at?.toMillis?.() ?? null })) : [],
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
    if (normalized) { setTracking(null); setError(""); setLoading(firebaseConfigured); setTicketId(normalized); setLookupRevision((current) => current + 1); }
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
        {justPlaced && <><div className="success-mark"><Check size={34} /></div><div className="eyebrow" style={{ textAlign: "center" }}>Demo payment successful</div><h1 className="success-title">Order sent to restaurant</h1><p className="success-copy">Your order and contact details are in the restaurant’s live queue. The manager’s preparation estimate will appear here once they set it. No real money was charged.</p></>}
        <section className="panel" style={{ marginTop: 20 }}>
          <div className="eyebrow">Track a ticket</div><h2 style={{ margin: "6px 0", fontSize: 24 }}>Your order, at a glance.</h2><p className="muted" style={{ marginTop: 0 }}>Enter the Ticket ID shown after you placed the order.</p>
          <form className="ticket-lookup" onSubmit={submitTicket}><input className="field" value={ticketInput} onChange={(event) => setTicketInput(event.target.value)} required placeholder="TS-…" aria-label="Ticket ID" /><button className="btn btn-primary" type="submit">Track <ArrowRight size={15} /></button></form>
          {configError && <div className="notice error">Firebase is not configured. Add the NEXT_PUBLIC_FIREBASE_* settings to load order tracking.</div>}
          {error && <div className="notice error">{error}</div>}
          {loading && <div className="loading">Looking up this ticket…</div>}
        </section>
      </>}

      {tracking && <>
        {justPlaced && <><div className="success-mark"><Check size={34} /></div><div className="eyebrow" style={{ textAlign: "center" }}>Demo payment successful</div><h1 className="success-title">Order sent to restaurant</h1><p className="success-copy">Your order and contact details are in the restaurant’s live queue. The manager’s preparation estimate will appear here once they set it. No real money was charged.</p></>}
        <section className="panel ticket-card">
          <div className="ticket-top"><div><div className="eyebrow">Ticket · Table {tracking.tableNumber}</div><div className="ticket-id">{tracking.ticketId}</div></div><button className="btn btn-soft btn-small" onClick={copyTicket}><Copy size={14} /> {copied ? "Copied" : "Copy ID"}</button></div>
          <div className="track-status-card">
            <div className="eyebrow">Current status</div><h2>{tracking.status === "queued" ? "In Queue" : humanizeStatus(tracking.status)}</h2>
            {tracking.status === "cancelled" ? <div className="notice error">This order was cancelled by the restaurant.</div> : <div className="eta-box"><div><small className="muted">Estimated preparation</small><div className="eta-value">{tracking.estimatedMinutes ? `${tracking.estimatedMinutes} min` : "Waiting"}</div><small className="muted">{expected ? `Expected around ${expected}` : "Waiting for restaurant confirmation"}</small></div><Clock3 size={22} color="#850d32" /></div>}
          </div>
          {tracking.status === "cancelled" ? <p className="muted" style={{ margin: "15px 0 0" }}>Contact the restaurant team if you need help with this order.</p> : <ol className="timeline">
            {statusSteps.map((status, index) => <li className={index <= currentIndex ? "done" : ""} key={status}><strong>{status === "queued" ? "In Queue" : humanizeStatus(status)}</strong><small>{statusTime(status) || (index === 0 ? "Order received" : index > currentIndex ? "Waiting for update" : "Updated by the restaurant")}</small></li>)}
          </ol>}
          {error && <div className="notice error" style={{ marginTop: 12 }}>{error}</div>}
        </section>
        {!justPlaced && <form className="ticket-lookup" onSubmit={submitTicket}><input className="field" value={ticketInput} onChange={(event) => setTicketInput(event.target.value)} placeholder="Track another ticket" aria-label="Ticket ID" /><button className="btn btn-soft" type="submit">Look up</button></form>}
        {loading && <div className="loading">Syncing order status…</div>}
      </>}
      <footer className="guest-footer"><CircleHelp size={15} style={{ verticalAlign: "middle", marginRight: 6 }} />Updates shown here come from the restaurant’s live order record.</footer>
    </div>
  </main>;
}
