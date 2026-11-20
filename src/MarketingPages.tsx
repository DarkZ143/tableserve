import type React from 'react';
import { lazy, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, BadgeCheck, Check, QrCode, Shield, Store, Gauge } from 'lucide-react';
import { BrandMark } from '../components/BrandMark';
import { runFirebaseAction } from '../lib/firebase-actions';
import { errorMessage, money } from '../lib/format';
import { firebaseConfigured } from '../lib/firebase';

type Plan = { id: string; name: string; pricePaise: number; orderLimit: number | null; description: string; features: string[]; isCustom: boolean; isTestOnly?: boolean; isActive?: boolean; sortOrder?: number; razorpayPlanId?: string };

function Brand({ inverse = false }: { inverse?: boolean }) { return <Link className={`brand ${inverse ? "brand-inverse" : ""}`} to="/"><BrandMark /><span><span className="brand-name">TableServe</span><span className="brand-sub">Scan / Order / Dine</span></span></Link>; }

const QrScanner = lazy(() => import('../components/QrScanner'));

export function LandingPage() {
  const navigate = useNavigate();
  const [scanOpen, setScanOpen] = useState(false);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [planError, setPlanError] = useState("");
  const handleScan = useCallback((path: string) => { setScanOpen(false); navigate(path); }, [navigate]);
  useEffect(() => {
    if (!firebaseConfigured) return;
    runFirebaseAction<Record<string, never>, { plans: Plan[] }>("listPlans", {}).then((result) => setPlans(result.plans)).catch((error: unknown) => setPlanError(errorMessage(error)));
  }, []);
  return <main className="marketing-shell">
    <header className="marketing-header"><Brand /><nav><a href="#features">Features</a><Link to="/pricing">Pricing</Link><Link to="/login">Sign in</Link><Link className="btn btn-primary btn-small" to="/register">Start your restaurant <ArrowRight size={14} /></Link></nav></header>
    <section className="marketing-hero">
      <div className="marketing-hero-copy"><span className="eyebrow">A more considered way to dine</span><h1>Bring the table<br /><em>closer to the kitchen.</em></h1><p>Give every guest a beautiful menu, a simple way to order, and a live view of their ticket. Your team gets one calm, real-time service workspace.</p><div className="marketing-actions"><Link className="btn btn-primary" to="/register">Create your restaurant <ArrowRight size={15} /></Link><Link className="btn btn-soft" to="/pricing">Explore plans</Link><button className="btn btn-quiet" type="button" onClick={() => setScanOpen(true)}><QrCode size={16} /> Scan table QR</button></div><div className="marketing-proof"><span><Check size={14} /> No customer app</span><span><Check size={14} /> Your menu stays yours</span><span><Check size={14} /> Email and password access</span></div></div>
      <div className="marketing-flow" aria-label="How QR ordering works"><div className="marketing-flow-mark"><BrandMark size={84} /></div><div className="marketing-flow-step"><span>01</span><div><strong>Scan the restaurant's table QR</strong><small>Each active QR resolves to its own restaurant and table.</small></div></div><div className="marketing-flow-step"><span>02</span><div><strong>Browse that restaurant's live menu</strong><small>Prices and availability come from the restaurant workspace.</small></div></div><div className="marketing-flow-step"><span>03</span><div><strong>Send an order to its live queue</strong><small>The kitchen and service team update the real ticket.</small></div></div></div>
    </section>
    <section className="benefit-strip"><div><span>01</span><strong>One QR per table</strong><small>Stable table identity, revocable links</small></div><div><span>02</span><strong>One live ticket</strong><small>Guest, manager and kitchen stay in sync</small></div><div><span>03</span><strong>One calm workspace</strong><small>Orders, menu and team in one place</small></div></section>
    <section className="marketing-features" id="features"><div className="section-intro"><span className="eyebrow">Thoughtful by design</span><h2>Hospitality, with less friction.</h2><p>Guests order from their own phone. Your staff stay focused on the room.</p></div><div className="feature-grid"><article className="feature-tile"><span className="feature-icon peach"><Store size={20} /></span><h3>Your restaurant, your space</h3><p>Keep each outlet's menu, settings, team and table links in its own protected workspace.</p></article><article className="feature-tile"><span className="feature-icon gold"><Gauge size={20} /></span><h3>A real service rhythm</h3><p>Orders move from the guest to the queue and kitchen, with updates guests can reopen later.</p></article><article className="feature-tile"><span className="feature-icon green"><Shield size={20} /></span><h3>Access with intention</h3><p>Owners assign staff roles and service tickets. Platform administration has its own provisioned access.</p></article></div></section>
    <section className="pricing-peek"><div><span className="eyebrow">One simple workspace plan</span><h2>Everything your team needs.</h2><p>Start with a free Firebase workspace. No payment setup or Cloud Functions are required.</p></div><div className="pricing-peek-cards">{plans.filter((plan) => !plan.isCustom).slice(0, 3).map((plan, index) => <PlanCard key={plan.id} plan={plan} featured={index === 1} />)}{!plans.length && <div className="notice">{planError || (firebaseConfigured ? "Loading current plans…" : "Connect Firebase to show live plan availability.")}</div>}</div><Link className="btn btn-quiet" to="/pricing">See all plan details <ArrowRight size={14} /></Link></section>
    {scanOpen && <QrScanner onClose={() => setScanOpen(false)} onScan={handleScan} />}
    <footer className="marketing-footer"><Brand /><span>Warm hospitality. Clearer service.</span><Link to="/master/login">Master Admin</Link></footer>
  </main>;
}

function PlanCard({ plan, featured = false, selected = false, onSelect }: { plan: Plan; featured?: boolean; selected?: boolean; onSelect?: () => void }) {
  const amount = plan.isCustom ? "Contract pricing" : plan.pricePaise === 0 ? "Free" : money(plan.pricePaise);
  const orderCopy = plan.isCustom ? "Quota set in the restaurant contract" : plan.orderLimit === null ? "Unlimited accepted orders" : `Up to ${plan.orderLimit.toLocaleString("en-IN")} accepted orders / cycle`;
  return <article className={`plan-card ${featured ? "featured" : ""} ${selected ? "selected" : ""}`}>
    {featured && <span className="plan-ribbon">Most chosen</span>}
    <div className="plan-card-top"><strong>{plan.name}</strong>{plan.isTestOnly && <span className="test-plan-label">Test mode only</span>}{selected && <BadgeCheck size={17} />}</div>
    <div className="plan-price">{amount}<small>{plan.isCustom ? "" : "/ month"}</small></div>
    <p>{plan.description}</p><div className="plan-limit"><Check size={14} /> {orderCopy}</div>
    <ul>{plan.features.slice(0, 4).map((feature) => <li key={feature}><Check size={13} />{feature}</li>)}</ul>
    {onSelect && <button type="button" className={`btn ${selected ? "btn-primary" : "btn-soft"}`} onClick={onSelect}>{selected ? "Selected" : plan.isCustom ? "Custom contract" : "Choose plan"}</button>}
  </article>;
}

export function PricingPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState("");
  useEffect(() => { if (firebaseConfigured) runFirebaseAction<Record<string, never>, { plans: Plan[] }>("listPlans", {}).then((result) => setPlans(result.plans)).catch((reason: unknown) => setError(errorMessage(reason))); }, []);
  return <main className="marketing-shell"><header className="marketing-header"><Brand /><nav><Link to="/">Home</Link><Link to="/login">Sign in</Link></nav></header><section className="pricing-page-intro"><span className="eyebrow">Firebase powered restaurant workspace</span><h1>A smoother shift<br /><em>for every restaurant.</em></h1><p>Every restaurant gets the full workspace for free. Accepted orders and live status updates are stored in Firestore.</p></section><section className="pricing-grid">{plans.length ? plans.map((plan) => <div key={plan.id}><PlanCard plan={plan} featured={plan.id === "growth"} />{plan.isCustom ? <p className="muted pricing-cta-note">Custom terms are assigned by a platform administrator after agreement. No sales contact is configured on this site.</p> : <Link className="btn btn-primary pricing-cta" to={`/register?plan=${plan.id}`}>Get started <ArrowRight size={14} /></Link>}</div>) : <div className="notice">{error || (firebaseConfigured ? "Loading plan catalog…" : "Plan prices will load from Firebase after configuration.")}</div>}</section><section className="billing-note"><span>Firebase Auth, Firestore and Storage power the workspace directly.</span></section></main>;
}

