"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate } from "react-router-dom";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { ArrowLeft, ArrowRight, Check, ChefHat, CircleHelp, Clock3, LockKeyhole, Minus, Plus, QrCode, Search, ShoppingBag, UtensilsCrossed, X } from "lucide-react";
import { runFirebaseAction } from "@/lib/firebase-actions";
import { BrandMark } from "@/components/BrandMark";
import { errorMessage, money } from "@/lib/format";
import { firebaseConfigured, getFirebase } from "@/lib/firebase";
import type { MenuCategory, MenuItem, TableContext } from "@/lib/types";
import QrScanner from "@/components/QrScanner";

type CartLine = {
  key: string;
  itemId: string;
  item: MenuItem;
  quantity: number;
  variantId?: string;
  addOnIds: string[];
  note: string;
  unitPricePaise: number;
  labels: string[];
};
type GuestForm = { customerName: string; customerPhone: string };

export default function CustomerFlow({ shopId, token }: { shopId: string; token?: string }) {
  const navigate = useNavigate();
  const [tableState, setTableState] = useState<{ token: string; context: TableContext } | null>(null);
  const table = token && tableState?.token === token ? tableState.context : null;
  const [mode, setMode] = useState<"welcome" | "menu" | "cart">(token ? "welcome" : "welcome");
  const [tableErrorState, setTableErrorState] = useState<{ token: string; message: string } | null>(null);
  const tableError = token && tableErrorState?.token === token ? tableErrorState.message : "";
  const resolving = Boolean(token && !table && !tableError);
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [menuError, setMenuError] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customizing, setCustomizing] = useState<MenuItem | null>(null);
  const [variantId, setVariantId] = useState("");
  const [addOnIds, setAddOnIds] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [checkoutError, setCheckoutError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [checkoutStage, setCheckoutStage] = useState<"details" | "payment">("details");
  const [checkoutCustomer, setCheckoutCustomer] = useState<GuestForm | null>(null);
  const idempotency = useRef<{ fingerprint: string; key: string } | null>(null);
  const [ticketSearch, setTicketSearch] = useState("");
  const [scanOpen, setScanOpen] = useState(false);
  const { register, handleSubmit, setError, formState: { errors } } = useForm<GuestForm>();

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    runFirebaseAction<{ shopId: string; token: string }, TableContext>("resolveTableQr", { shopId, token })
      .then((context) => { if (!cancelled) setTableState({ token, context }); })
      .catch((error: unknown) => {
        if (cancelled) return;
        setTableErrorState({ token, message: errorMessage(error) });
      });
    return () => { cancelled = true; };
  }, [shopId, token]);

  useEffect(() => {
    if (!table || !firebaseConfigured) return;
    const { db } = getFirebase();
    const stopCategories = onSnapshot(
      query(collection(db, "restaurants", table.restaurantId, "categories"), where("isActive", "==", true)),
      (snapshot) => setCategories(snapshot.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }) as MenuCategory)
        .sort((left, right) => Number(left.sortOrder ?? 0) - Number(right.sortOrder ?? 0) || left.name.localeCompare(right.name))),
      (error) => setMenuError(error.message),
    );
    const stopItems = onSnapshot(
      query(collection(db, "restaurants", table.restaurantId, "menuItems"), where("isActive", "==", true), where("isAvailable", "==", true)),
      (snapshot) => setItems(snapshot.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }) as MenuItem)
        .sort((left, right) => left.name.localeCompare(right.name))),
      (error) => setMenuError(error.message),
    );
    return () => { stopCategories(); stopItems(); };
  }, [table]);

  const visibleItems = useMemo(() => items.filter((item) => item.isAvailable &&
    (activeCategory === "all" || item.categoryId === activeCategory) &&
    (!search.trim() || `${item.name} ${item.description}`.toLowerCase().includes(search.trim().toLowerCase()))),
  [items, activeCategory, search]);
  const cartCount = cart.reduce((sum, line) => sum + line.quantity, 0);
  const subtotal = cart.reduce((sum, line) => sum + line.unitPricePaise * line.quantity, 0);
  const tax = Math.round(subtotal * (table?.taxRateBps ?? 0) / 10000);
  const serviceFee = subtotal ? (table?.serviceFeePaise ?? 0) : 0;
  const total = subtotal + tax + serviceFee;

  function addLine(item: MenuItem, selectedVariant = "", selectedAddOns: string[] = [], specialNote = "") {
    const variant = item.variants?.find((choice) => choice.id === selectedVariant);
    const addOns = (item.addOns ?? []).filter((choice) => selectedAddOns.includes(choice.id));
    const unitPricePaise = item.pricePaise + (variant?.priceDeltaPaise ?? 0) + addOns.reduce((sum, choice) => sum + (choice.pricePaise ?? 0), 0);
    const labels = [variant?.name, ...addOns.map((choice) => choice.name)].filter((label): label is string => Boolean(label));
    const key = [item.id, selectedVariant, [...selectedAddOns].sort().join(","), specialNote.trim()].join("|");
    setCart((current) => {
      const existing = current.find((line) => line.key === key);
      if (existing) return current.map((line) => line.key === key ? { ...line, quantity: line.quantity + 1 } : line);
      return [...current, { key, itemId: item.id, item, quantity: 1, variantId: selectedVariant || undefined, addOnIds: selectedAddOns, note: specialNote.trim(), unitPricePaise, labels }];
    });
    setCustomizing(null);
    setCheckoutStage("details");
    setCheckoutCustomer(null);
    setMode("menu");
  }

  function changeQuantity(key: string, change: number) {
    setCart((current) => current.map((line) => line.key === key ? { ...line, quantity: line.quantity + change } : line).filter((line) => line.quantity > 0));
    setCheckoutStage("details");
    setCheckoutCustomer(null);
  }

  function addItem(item: MenuItem) {
    if ((item.variants?.length ?? 0) > 0 || (item.addOns?.length ?? 0) > 0 || item.variantRequired) {
      setCustomizing(item);
      setVariantId(item.variants?.[0]?.id ?? "");
      setAddOnIds([]);
      setNote("");
      return;
    }
    addLine(item);
  }

  async function placeOrder(form: GuestForm) {
    setCheckoutError("");
    const name = form.customerName.trim();
    const phone = form.customerPhone.trim();
    if (name.length < 2 || name.length > 80) {
      setError("customerName", { message: "Enter a name between 2 and 80 characters." });
      return;
    }
    if (!/^\+?[0-9()\-\s]{8,20}$/.test(phone)) {
      setError("customerPhone", { message: "Enter a valid phone number." });
      return;
    }
    if (!token || !cart.length) return;
    const requestItems = cart.map((line) => ({ itemId: line.itemId, quantity: line.quantity, variantId: line.variantId, addOnIds: line.addOnIds, specialInstructions: line.note || undefined }));
    const fingerprint = JSON.stringify({ token, customerName: name, customerPhone: phone, items: requestItems });
    if (!idempotency.current || idempotency.current.fingerprint !== fingerprint) idempotency.current = { fingerprint, key: crypto.randomUUID() };
    setSubmitting(true);
    try {
      const result = await runFirebaseAction<{
        shopId: string;
        qrToken: string;
        idempotencyKey: string;
        customerName: string;
        customerPhone: string;
        mockPaymentConfirmed: true;
        items: { itemId: string; quantity: number; variantId?: string; addOnIds: string[]; specialInstructions?: string }[];
      }, { ticketId: string }>("placeOrder", {
        shopId,
        qrToken: token,
        idempotencyKey: idempotency.current.key,
        customerName: name,
        customerPhone: phone,
        mockPaymentConfirmed: true,
        items: requestItems,
      });
      navigate(`/t/${shopId}/${token}/success/${encodeURIComponent(result.ticketId)}`);
    } catch (error) {
      setCheckoutError(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  function openCart() {
    setMode("cart");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function goToTicket() {
    const id = ticketSearch.trim().toUpperCase();
    if (id) navigate(`/track/${encodeURIComponent(id)}`);
  }

  const handleQrScan = useCallback((path: string) => {
    setScanOpen(false);
    navigate(path);
  }, [navigate]);

  function submitGuestForm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (checkoutStage === "details") {
      void handleSubmit((form) => {
        const name = form.customerName.trim();
        const phone = form.customerPhone.trim();
        if (name.length < 2 || name.length > 80) {
          setError("customerName", { message: "Enter a name between 2 and 80 characters." });
          return;
        }
        if (!/^\+?[0-9()\-\s]{8,20}$/.test(phone)) {
          setError("customerPhone", { message: "Enter a valid phone number." });
          return;
        }
        setCheckoutError("");
        setCheckoutCustomer({ customerName: name, customerPhone: phone });
        setCheckoutStage("payment");
      })(event);
      return;
    }
    if (!checkoutCustomer) {
      setCheckoutStage("details");
      setCheckoutError("Enter your name and phone number before payment.");
      return;
    }
    void placeOrder(checkoutCustomer);
  }

  if (token && resolving) return <GuestState title="Finding your table" copy="Checking this table’s secure QR link…" />;
  if (token && (!table || tableError)) return <GuestState title="This table link is unavailable" copy={tableError || "We couldn’t validate this QR code."} error />;

  return (
    <main className="guest-shell">
      <div className="guest-wrap">
        <header className="guest-header">
          <Link className="brand" to="/" aria-label="TableServe home">
            <BrandMark />
            <span><span className="brand-name">TableServe</span><span className="brand-sub">A better table experience</span></span>
          </Link>
          {table ? <span className="table-badge"><span className="status-dot" /> Table {table.tableNumber} <small>· locked</small></span> : <Link className="pill" to="/login">Staff sign in</Link>}
        </header>

        {mode === "welcome" && (
          <>
            <section className="guest-hero">
              <span className="hero-symbol"><UtensilsCrossed size={27} /></span>
              <div className="eyebrow">Scan · Order · Dine</div>
              <h1>{table ? table.restaurantName : "A thoughtful meal, made easy"}</h1>
              <p>{table ? "Your table is connected to this menu." : "Scan your table’s QR code to browse the menu and order."}</p>
            </section>
            {table && <div className="session-card">
              <div className="session-main"><span className="hero-symbol" style={{ width: 39, height: 39, margin: 0, fontSize: 16 }}><LockKeyhole size={17} /></span><div><strong>Table {table.tableNumber} detected</strong><span>Dining session ready</span></div></div>
              <span className="locked-label"><Check size={14} /> Locked to this table</span>
            </div>}
            {!table && <section className="guest-scan-instruction"><BrandMark size={72} /><p>Scan the QR placed at your table to open this restaurant's live menu.</p></section>}
            <div className="guest-actions">
              {table && <button className="btn btn-primary" onClick={() => setMode("menu")}><span><UtensilsCrossed size={17} /> Order Food · Table {table.tableNumber}</span><ArrowRight size={18} /></button>}
              {!table && <button className="btn btn-primary" onClick={() => setScanOpen(true)}><span><QrCode size={18} /> Scan table QR to order</span><ArrowRight size={18} /></button>}
              <div className="ticket-lookup">
                <input className="field" value={ticketSearch} onChange={(event) => setTicketSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") goToTicket(); }} placeholder="Ticket ID, e.g. TS-…" aria-label="Ticket ID" />
                <button className="btn btn-soft" onClick={goToTicket}><Clock3 size={16} /> Track</button>
              </div>
            </div>
            {scanOpen && <QrScanner onClose={() => setScanOpen(false)} onScan={handleQrScan} />}
            {!table && <div className="feature-row">
              <div className="feature-card"><span>♧</span>Touchless menu</div><div className="feature-card"><span>⌁</span>Live kitchen updates</div><div className="feature-card"><span>⌖</span>Orders stay at your table</div>
            </div>}
            <footer className="guest-footer"><CircleHelp size={16} style={{ verticalAlign: "middle", marginRight: 6 }} />Need a hand? Ask a member of the restaurant team.</footer>
          </>
        )}

        {mode === "menu" && table && (
          <>
            <div className="session-card">
              <div className="session-main"><span className="hero-symbol" style={{ width: 39, height: 39, margin: 0, fontSize: 16 }}><ChefHat size={18} /></span><div><strong>{table.restaurantName}</strong><span>Freshly prepared for Table {table.tableNumber}</span></div></div>
              <span className="locked-label"><LockKeyhole size={14} /> Table {table.tableNumber}</span>
            </div>
            <div className="menu-tools">
              <label className="menu-search"><span className="field" style={{ display: "flex", alignItems: "center", gap: 9 }}><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search the menu" style={{ width: "100%", border: 0, outline: 0, background: "transparent" }} /></span></label>
              <div className="menu-categories">
                <button className={`category-chip ${activeCategory === "all" ? "active" : ""}`} onClick={() => setActiveCategory("all")}>All dishes</button>
                {categories.map((category) => <button key={category.id} className={`category-chip ${activeCategory === category.id ? "active" : ""}`} onClick={() => setActiveCategory(category.id)}>{category.name}</button>)}
              </div>
            </div>
            {!table.isAcceptingOrders && <div className="notice" style={{ marginTop: 10 }}>Online ordering is temporarily unavailable. Please contact staff. You can still browse the menu.</div>}
            {menuError && <div className="notice error">The live menu could not be loaded: {menuError}</div>}
            <div className="menu-heading"><h2>{activeCategory === "all" ? "The menu" : categories.find((category) => category.id === activeCategory)?.name}</h2><span className="muted">{visibleItems.length} available</span></div>
            {visibleItems.length === 0 ? <div className="empty-state"><h3>{items.length ? "Nothing here just yet" : "The menu is being prepared"}</h3><p>{items.length ? "Try another category or search term." : "The restaurant’s current menu will appear here as soon as it is published."}</p></div> :
              <div className="menu-list">
                {visibleItems.map((item) => {
                  const inCart = cart.filter((line) => line.itemId === item.id).reduce((sum, line) => sum + line.quantity, 0);
                  return <article className="menu-item" key={item.id}>
                    <div className="menu-item-image">{item.imageUrl ? <img src={item.imageUrl} alt={item.name} loading="lazy" /> : <UtensilsCrossed size={24} />}</div>
                    <div className="menu-item-info">
                      <div className="menu-item-title"><span className={`diet-mark ${item.dietaryType}`} title={item.dietaryType === "veg" ? "Vegetarian" : "Non-vegetarian"}>{item.dietaryType === "non-veg" ? "▲" : ""}</span><h3>{item.name}</h3></div>
                      <p>{item.description}</p>
                      <div className="menu-item-bottom"><strong className="price">{money(item.pricePaise)}</strong>{inCart ? <span className="pill">{inCart} in cart</span> : null}<button className="btn btn-soft btn-small" onClick={() => addItem(item)}>{(item.variants?.length || item.addOns?.length) ? "Customize" : "Add"} <Plus size={14} /></button></div>
                    </div>
                  </article>;
                })}
              </div>}
            {cartCount > 0 && <div className="sticky-cart"><div className="cart-count"><span>{cartCount} {cartCount === 1 ? "item" : "items"} · Table {table.tableNumber}</span><strong>{money(subtotal)}</strong></div><button className="btn btn-primary" onClick={openCart}>View cart <ArrowRight size={16} /></button></div>}
            <nav className="mobile-nav"><button onClick={() => setMode("menu")}><span><UtensilsCrossed size={16} /></span>Menu</button><button onClick={() => document.querySelector<HTMLInputElement>(".menu-search input")?.focus()}><span><Search size={16} /></span>Search</button><button onClick={openCart}><span><ShoppingBag size={16} /></span>Cart{cartCount ? ` · ${cartCount}` : ""}</button><Link to="/track"><span>◷</span>Track</Link></nav>
          </>
        )}

        {mode === "cart" && table && <section className="cart-page">
          <button className="btn btn-quiet btn-small" onClick={() => { setCheckoutStage("details"); setCheckoutCustomer(null); setMode("menu"); }}><ArrowLeft size={15} /> Back to menu</button>
          <div className="menu-heading"><div><div className="eyebrow">Review your order</div><h2>Your cart</h2></div><span className="pill">Table {table.tableNumber} · locked</span></div>
          {cart.length === 0 ? <div className="empty-state"><h3>Your cart is empty</h3><p>Choose a dish from the live restaurant menu.</p><button className="btn btn-primary" onClick={() => setMode("menu")}>Browse menu</button></div> : <>
            <div className="surface-card" style={{ padding: "0 15px" }}>
              {cart.map((line) => <div className="cart-line" key={line.key}>
                <div><h3>{line.item.name}</h3><p>{[...line.labels, line.note].filter(Boolean).join(" · ") || "Prepared fresh"}</p><strong className="price">{money(line.unitPricePaise * line.quantity)}</strong></div>
                <div className="qty-control"><button onClick={() => changeQuantity(line.key, -1)} aria-label={`Remove one ${line.item.name}`}><Minus size={13} /></button><span>{line.quantity}</span><button onClick={() => changeQuantity(line.key, 1)} aria-label={`Add one ${line.item.name}`}><Plus size={13} /></button></div>
              </div>)}
            </div>
            <form className="surface-card" style={{ marginTop: 13, padding: 16 }} onSubmit={submitGuestForm}>
              <div className="eyebrow">{checkoutStage === "details" ? "Checkout · step 1 of 2" : "Checkout · step 2 of 2"}</div><h2 style={{ margin: "4px 0", fontSize: 24 }}>{checkoutStage === "details" ? "Your table, taken care of." : "Pay before your order"}</h2>
              <div className="locked-table"><span><strong>Table {table.tableNumber}</strong><small className="muted" style={{ display: "block", marginTop: 4 }}>This table is linked to your QR code</small></span><span className="locked-label"><LockKeyhole size={14} /> Read only</span></div>
              {checkoutStage === "details" ? <div className="checkout-fields">
                <label className="field-label">Your name<input className="field" autoComplete="name" {...register("customerName", { required: "Please enter your name.", minLength: { value: 2, message: "Enter at least 2 characters." } })} placeholder="Name for the order" /></label>
                {errors.customerName && <small className="muted">{errors.customerName.message}</small>}
                <label className="field-label">Phone number<input className="field" type="tel" autoComplete="tel" {...register("customerPhone", { required: "Please enter your phone number." })} placeholder="For order updates" /></label>
                {errors.customerPhone && <small className="muted">{errors.customerPhone.message}</small>}
              </div> : <>
                <div className="session-card" style={{ marginTop: 13 }}>
                  <div className="session-main"><span className="hero-symbol" style={{ width: 39, height: 39, margin: 0, fontSize: 16 }}>₹</span><div><strong>Mock payment · demo only</strong><span>No real money will be charged</span></div></div>
                  <span className="locked-label"><Check size={14} /> Pay first</span>
                </div>
                <p className="muted" style={{ margin: "10px 0" }}>Order for {checkoutCustomer?.customerName} · {checkoutCustomer?.customerPhone}. This payment is simulated; connect a payment gateway before using it to collect real money.</p>
                <button className="btn btn-quiet btn-small" type="button" onClick={() => { setCheckoutStage("details"); setCheckoutError(""); }}>Edit name or phone</button>
              </>}
              <div className="totals">
                <div className="totals-row"><span>Items subtotal</span><strong>{money(subtotal)}</strong></div>
                <div className="totals-row"><span>Tax</span><strong>{money(tax)}</strong></div>
                {serviceFee > 0 && <div className="totals-row"><span>Service fee</span><strong>{money(serviceFee)}</strong></div>}
                <div className="totals-row grand"><span>Order total</span><strong>{money(total)}</strong></div>
              </div>
              {checkoutError && <div className="notice error" style={{ marginBottom: 12 }}>{checkoutError}</div>}
              <button className="btn btn-primary" type="submit" disabled={submitting || !table.isAcceptingOrders} style={{ width: "100%", minHeight: 52 }}>{submitting ? "Sending your order…" : !table.isAcceptingOrders ? "Ordering paused" : checkoutStage === "details" ? "Continue to payment" : `Pay ${money(total)} (mock) & place order`}<ArrowRight size={17} /></button>
              <p className="muted" style={{ margin: "10px 0 0", textAlign: "center", fontSize: 10 }}>{checkoutStage === "details" ? "Payment is required before the order is sent." : "Mock payment only. No money will be charged."}</p>
            </form>
          </>}
        </section>}
      </div>

      {customizing && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCustomizing(null); }}>
        <section className="modal-sheet" role="dialog" aria-modal="true" aria-label={`Customize ${customizing.name}`}>
          <div className="panel-heading"><div><div className="eyebrow">Made your way</div><h2>{customizing.name}</h2><p className="muted" style={{ margin: 0 }}>{customizing.description}</p></div><button className="icon-button" onClick={() => setCustomizing(null)} aria-label="Close"><X size={18} /></button></div>
          {customizing.variants?.length ? <section><strong>Choose a portion{customizing.variantRequired ? " · required" : ""}</strong><div className="choice-list">{customizing.variants.map((choice) => <label key={choice.id} className="choice-row"><span><input type="radio" checked={variantId === choice.id} onChange={() => setVariantId(choice.id)} name="variant" /> {choice.name}</span><strong>{(choice.priceDeltaPaise ?? 0) > 0 ? `+${money(choice.priceDeltaPaise ?? 0)}` : "Included"}</strong></label>)}</div></section> : null}
          {customizing.addOns?.length ? <section><strong>Gourmet accompaniments</strong><div className="choice-list">{customizing.addOns.map((choice) => <label key={choice.id} className="choice-row"><span><input type="checkbox" checked={addOnIds.includes(choice.id)} onChange={(event) => setAddOnIds((current) => event.target.checked ? [...current, choice.id] : current.filter((id) => id !== choice.id))} /> {choice.name}</span><strong>+{money(choice.pricePaise ?? 0)}</strong></label>)}</div></section> : null}
          <section><label className="field-label">Note for the chef <textarea className="field" rows={3} maxLength={250} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Allergies or special requests" /></label></section>
          <button className="btn btn-primary" style={{ width: "100%", marginTop: 16 }} disabled={Boolean(customizing.variantRequired && !variantId)} onClick={() => addLine(customizing, variantId, addOnIds, note)}>Add to cart <ArrowRight size={16} /></button>
        </section>
      </div>}
    </main>
  );
}

function GuestState({ title, copy, error = false }: { title: string; copy: string; error?: boolean }) {
  return <main className="guest-shell"><div className="guest-wrap"><header className="guest-header"><Link className="brand" to="/"><BrandMark /><span><span className="brand-name">TableServe</span><span className="brand-sub">A better table experience</span></span></Link></header><section className="guest-hero"><span className="hero-symbol">{error ? <CircleHelp size={25} /> : <Clock3 size={25} />}</span><h1>{title}</h1><p>{copy}</p>{error && <Link className="btn btn-soft" style={{ marginTop: 20 }} to="/">Return to TableServe</Link>}</section></div></main>;
}
