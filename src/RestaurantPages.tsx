import type React from 'react';
import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { ArrowRight, BadgeCheck, Building2, Check, LogOut, Store } from 'lucide-react';
import { BrandMark } from '../components/BrandMark';
import { runFirebaseAction } from '../lib/firebase-actions';
import { errorMessage, money } from '../lib/format';
import { firebaseConfigured, getFirebase } from '../lib/firebase';
import type { StaffRole } from '../lib/types';

type Plan = { id: string; name: string; pricePaise: number; orderLimit: number | null; description: string; features: string[]; isCustom: boolean; isTestOnly?: boolean; isActive?: boolean; sortOrder?: number; razorpayPlanId?: string };

type Shop = { shopId: string; name: string; role: StaffRole };
type Subscription = { shopId: string; planId: string; providerMode: "test" | "live" | null; planName: string; amountPaise: number; orderLimit: number | null; status: string; currentUsage: number; currentPeriodStartMs: number | null; currentPeriodEndMs: number | null; graceEndsAtMs: number | null; checkoutUrl: string | null; providerSubscriptionId: string | null; providerStatus: string | null; billingPeriod: string; cancelAtCycleEnd: boolean; cancelEffectiveAtMs: number | null; pendingCustomContract: { planName: string; amountPaise: number; orderLimit: number | null; renewalTerms: string; status: string } | null; pendingPlanChange: { planId: string; planName: string; amountPaise: number; orderLimit: number | null; scheduleChangeAt: "now" | "cycle_end" } | null; payments: { id: string; amountPaise: number; currency: string; status: string; event: string; createdAtMs: number | null }[] };

function Brand({ inverse = false }: { inverse?: boolean }) { return <Link className={`brand ${inverse ? "brand-inverse" : ""}`} to="/"><BrandMark /><span><span className="brand-name">TableServe</span><span className="brand-sub">Scan / Order / Dine</span></span></Link>; }

function PlanCard({ plan, featured = false, selected = false, onSelect }: { plan: Plan; featured?: boolean; selected?: boolean; onSelect?: () => void }) {
  const amount = plan.isCustom ? "Contract pricing" : plan.pricePaise === 0 ? "Free" : money(plan.pricePaise);
  const orderCopy = plan.isCustom ? "Quota set in the restaurant contract" : plan.orderLimit === null ? "Unlimited accepted orders" : `Up to ${plan.orderLimit.toLocaleString("en-IN")} accepted orders / cycle`;
  return <article className={`plan-card ${featured ? "featured" : ""} ${selected ? "selected" : ""}`}>{featured && <span className="plan-ribbon">Most chosen</span>}<div className="plan-card-top"><strong>{plan.name}</strong>{plan.isTestOnly && <span className="test-plan-label">Test mode only</span>}{selected && <BadgeCheck size={17} />}</div><div className="plan-price">{amount}<small>{plan.isCustom ? "" : "/ month"}</small></div><p>{plan.description}</p><div className="plan-limit"><Check size={14} /> {orderCopy}</div><ul>{plan.features.slice(0, 4).map((feature) => <li key={feature}><Check size={13} />{feature}</li>)}</ul>{onSelect && <button type="button" className={`btn ${selected ? "btn-primary" : "btn-soft"}`} onClick={onSelect}>{selected ? "Selected" : plan.isCustom ? "Custom contract" : "Choose plan"}</button>}</article>;
}

export function ShopsPage() {
  const [user, setUser] = useState<User | null>(null); const [shops, setShops] = useState<Shop[]>([]); const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
  useEffect(() => { if (!firebaseConfigured) { setLoading(false); return; } return onAuthStateChanged(getFirebase().auth, async (nextUser) => { setUser(nextUser); if (!nextUser) { setLoading(false); return; } try { const result = await runFirebaseAction<Record<string, never>, { shops: Shop[] }>("listMyRestaurants", {}); setShops(result.shops); } catch (reason) { setError(errorMessage(reason)); } finally { setLoading(false); } }); }, []);
  if (!firebaseConfigured) return <main className="simple-page"><div className="panel simple-form"><Brand /><div className="notice">Add Firebase web configuration to use restaurant workspaces.</div></div></main>;
  if (!user && !loading) return <Navigate to="/login" replace />;
  return <main className="shop-picker"><header className="marketing-header"><Brand /><button className="btn btn-quiet btn-small" onClick={() => signOut(getFirebase().auth)}><LogOut size={14} /> Sign out</button></header><section className="shop-picker-intro"><span className="eyebrow">Your workspaces</span><h1>Choose a restaurant.</h1><p>Only restaurants where your account has active membership are listed here.</p></section>{error && <div className="notice error">{error}</div>}{loading ? <div className="loading">Loading your restaurantsâ€¦</div> : <div className="shop-picker-grid">{shops.map((shop) => <Link className="shop-card" key={shop.shopId} to={`/app/${shop.shopId}/dashboard`}><span className="shop-card-icon"><Building2 size={21} /></span><span><strong>{shop.name}</strong><small>{shop.role} Â· {shop.shopId}</small></span><ArrowRight size={17} /></Link>)}<Link className="shop-card shop-card-new" to="/onboarding"><span className="shop-card-icon"><Store size={21} /></span><span><strong>Create another restaurant</strong><small>Every shop has separate staff, menu, orders and billing.</small></span><ArrowRight size={17} /></Link></div>}</main>;
}

export function OnboardingPage() {
  const navigate = useNavigate(); const [searchParams] = useSearchParams();
  const [user, setUser] = useState<User | null>(null); const [plans, setPlans] = useState<Plan[]>([]); const [planId, setPlanId] = useState(searchParams.get("plan") ?? "starter");
  const [values, setValues] = useState({ name: "", ownerName: "", phone: "", address: "", city: "", state: "", postalCode: "", cuisine: "", timezone: "Asia/Kolkata" });
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
  useEffect(() => { if (!firebaseConfigured) { setLoading(false); return; } const stop = onAuthStateChanged(getFirebase().auth, (nextUser) => { setUser(nextUser); setValues((current) => ({ ...current, ownerName: current.ownerName || nextUser?.displayName || "" })); setLoading(false); }); runFirebaseAction<Record<string, never>, { plans: Plan[] }>("listPlans", {}).then((result) => { setPlans(result.plans); setPlanId((current) => result.plans.some((plan) => plan.id === current && !plan.isCustom) ? current : result.plans.find((plan) => !plan.isCustom)?.id ?? ""); }).catch((reason: unknown) => setError(errorMessage(reason))); return stop; }, []);
  async function submit(event: React.FormEvent<HTMLFormElement>) { event.preventDefault(); setError(""); if (!user) { navigate("/login?next=/onboarding"); return; } setBusy(true); try { await user.reload(); if (!user.emailVerified) throw new Error("Verify your email address before creating a restaurant."); const result = await runFirebaseAction<typeof values & { planId: string }, { shopId: string; status: string }>("createRestaurant", { ...values, planId }); navigate(`/app/${result.shopId}/subscription`, { replace: true }); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); } }
  if (!firebaseConfigured) return <main className="simple-page"><div className="panel simple-form"><Brand /><div className="notice">Connect Firebase to finish onboarding. No restaurant record has been created.</div><Link to="/register" className="btn btn-soft">Create an owner account</Link></div></main>;
  if (loading) return <div className="loading" style={{ paddingTop: "20vh" }}>Loading onboardingâ€¦</div>;
  if (!user) { const selectedPlan = searchParams.get("plan"); const onboardingPath = `/onboarding${selectedPlan ? `?plan=${encodeURIComponent(selectedPlan)}` : ""}`; const next = `?next=${encodeURIComponent(onboardingPath)}`; return <main className="simple-page"><section className="panel simple-form"><Brand /><span className="eyebrow">Step 1 Â· Account</span><h1>Sign in to continue.</h1><p className="muted">Create or sign in to an Email/Password account, verify the email, then add your restaurant details.</p><Link className="btn btn-primary" to={`/register${next}`}>Create owner account</Link><Link className="btn btn-soft" to={`/login${next}`}>I already have an account</Link></section></main>; }
  return <main className="onboarding-shell"><header className="marketing-header"><Brand /><span className="pill"><span className="status-dot" /> Account Â· {user.email}</span></header><section className="onboarding-intro"><span className="eyebrow">Step 2 Â· Restaurant details</span><h1>Set your table.</h1><p>Create your workspace, add a menu and tables, then switch on online ordering when you are ready.</p></section><form className="onboarding-form" onSubmit={submit}><section className="panel onboarding-fields"><div className="form-section-title"><span>01</span><div><h2>Restaurant profile</h2><p>Tell guests and your team who this space belongs to.</p></div></div><div className="onboarding-grid"><Field label="Restaurant name" required value={values.name} onChange={(name) => setValues({ ...values, name })} /><Field label="Owner name" required value={values.ownerName} onChange={(ownerName) => setValues({ ...values, ownerName })} /><Field label="Restaurant phone" required value={values.phone} onChange={(phone) => setValues({ ...values, phone })} /><Field label="Cuisine" value={values.cuisine} onChange={(cuisine) => setValues({ ...values, cuisine })} /><Field label="Street address" required value={values.address} onChange={(address) => setValues({ ...values, address })} /><Field label="City" required value={values.city} onChange={(city) => setValues({ ...values, city })} /><Field label="State" required value={values.state} onChange={(state) => setValues({ ...values, state })} /><Field label="Postal code" required value={values.postalCode} onChange={(postalCode) => setValues({ ...values, postalCode })} /></div></section><section className="onboarding-plan"><div className="form-section-title"><span>02</span><div><h2>Choose a plan</h2><p>Use every TableServe workspace feature with the free Firebase setup.</p></div></div><div className="onboarding-plan-grid">{plans.filter((plan) => !plan.isCustom).map((plan) => <PlanCard key={plan.id} plan={plan} featured={plan.id === "growth"} selected={planId === plan.id} onSelect={() => setPlanId(plan.id)} />)}</div><p className="muted onboarding-note">No payment gateway or Cloud Functions setup is needed.</p></section>{error && <div className="notice error">{error}</div>}<button className="btn btn-primary onboarding-submit" disabled={busy || !planId}>{busy ? "Creating secure workspaceâ€¦" : "Create free restaurant workspace"}<ArrowRight size={15} /></button></form></main>;
}

function Field({ label, value, onChange, required = false }: { label: string; value: string; onChange: (value: string) => void; required?: boolean }) {
  return <label className="field-label">{label}<input className="field" value={value} required={required} onChange={(event) => onChange(event.target.value)} /></label>;
}

export function BillingPage() {
  const { shopId = "" } = useParams();
  const [user, setUser] = useState<User | null>(null);
  const [billing, setBilling] = useState<Subscription | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!firebaseConfigured) { setLoading(false); return; }
    return onAuthStateChanged(getFirebase().auth, async (nextUser) => {
      setUser(nextUser);
      if (!nextUser) { setLoading(false); return; }
      try {
        await runFirebaseAction<{ shopId: string }, unknown>("getMyShopAccess", { shopId });
        const result = await runFirebaseAction<Record<string, never>, Subscription>("getSubscription", {});
        setBilling(result);
      } catch (reason) { setError(errorMessage(reason)); }
      finally { setLoading(false); }
    });
  }, [shopId]);
  if (!firebaseConfigured) return <main className="simple-page"><div className="panel simple-form"><Brand /><div className="notice">Connect Firebase to manage this workspace.</div></div></main>;
  if (loading) return <div className="loading" style={{ paddingTop: "20vh" }}>Loading workspace plan…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <main className="billing-shell">
    <header className="marketing-header"><Brand /><Link to={`/app/${shopId}/dashboard`} className="btn btn-quiet btn-small">Back to restaurant workspace <ArrowRight size={14} /></Link></header>
    <section className="billing-intro"><span className="eyebrow">Workspace plan · {shopId}</span><h1>Your restaurant tools.</h1><p>TableServe runs directly on Firebase Authentication, Firestore and Storage.</p></section>
    {error && <div className="notice error">{error}</div>}
    {billing && <section className="billing-overview">
      <article className="billing-current-plan"><div className="billing-current-plan-head"><div><span className="eyebrow">Current plan</span><h2>{billing.planName}</h2></div><span className="billing-status status-active">Active</span></div>
        <div className="billing-current-price">Free</div>
        <div className="billing-facts"><div><span>Order limit</span><strong>Unlimited</strong></div><div><span>Payment setup</span><strong>Not required</strong></div><div><span>Data storage</span><strong>Firebase Firestore</strong></div></div>
        <ul className="plan-feature-list"><li>Table QR codes and live order tracking</li><li>Menu, kitchen and waiter workspaces</li><li>Restaurant staff invitations</li><li>Order usage and history</li></ul>
      </article>
      <article className="billing-usage"><div className="panel-heading"><div><span className="eyebrow">Accepted orders</span><h2>{billing.currentUsage.toLocaleString("en-IN")} <small>orders</small></h2></div><span className="usage-ring">No cap</span></div><p>Usage is recorded in Firestore when a restaurant accepts an order. There is no paid plan or payment provider in this Firebase-only setup.</p></article>
    </section>}
  </main>;
}
