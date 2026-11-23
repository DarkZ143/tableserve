"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { createUserWithEmailAndPassword, onAuthStateChanged, sendEmailVerification, signInWithEmailAndPassword, signOut, updateProfile, type User } from "firebase/auth";
import { collection, doc, limit, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { createPortal } from "react-dom";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { QRCodeCanvas } from "qrcode.react";
import { Mail, MessageCircle } from "lucide-react";
import { Activity, ArrowRight, BarChart3, BookOpen, ChefHat, CircleHelp, ClipboardList, Copy, Download, ImagePlus, LayoutDashboard, LogOut, Pencil, Plus, Printer, QrCode, RefreshCw, Save, Settings2, ShieldCheck, Table2, ToggleLeft, ToggleRight, Users, X } from "lucide-react";
import { runFirebaseAction } from "@/lib/firebase-actions";
import { parseMenuImportFile } from "@/lib/menu-import";
import { tableQrUrl as buildTableQrUrl } from "@/lib/qr";
import { BrandMark } from "@/components/BrandMark";
import EtaCountdown from "@/components/EtaCountdown";
import { errorMessage, humanizeStatus, money } from "@/lib/format";
import { firebaseConfigured, getFirebase } from "@/lib/firebase";
import type { AdminOrder, MenuCategory, MenuItem, OrderStatus, StaffRole, TableRecord, WaiterOrder } from "@/lib/types";
import type { MenuImportRow } from "@/lib/menu-import";

type Section = "overview" | "orders" | "assigned" | "kitchen" | "menu" | "tables" | "customers" | "analytics" | "history" | "staff" | "settings" | "notifications" | "activity";
type StaffRecord = { uid: string; email?: string; displayName?: string; role: StaffRole; isActive: boolean };
type RestaurantSettings = { name: string; taxRateBps: number; serviceFeePaise: number; isAcceptingOrders: boolean; payAtRestaurantEnabled: boolean; upiEnabled: boolean; upiId: string; upiPayeeName: string };
type SubscriptionNoticeData = { status: string; currentUsage: number; orderLimit: number | null; currentPeriodEndMs: number | null };
type CloudinaryUploadResult = { secure_url?: string; error?: { message?: string }; bytes?: number; format?: string };
type DishCropSource = { kind: "file"; file: File } | { kind: "cloudinary"; imageUrl: string };
type DishCropResult = { kind: "file"; file: File } | { kind: "cloudinary"; imageUrl: string };

const CUSTOMER_APP_ORIGIN = "https://tableserve-mu.vercel.app";

const navItems: { id: Section; label: string; icon: typeof LayoutDashboard; managerOnly?: boolean; ownerOnly?: boolean; waiterOnly?: boolean; notWaiterOnly?: boolean }[] = [
  { id: "overview", label: "Dashboard Overview", icon: LayoutDashboard, managerOnly: true },
  { id: "orders", label: "Live Orders", icon: ClipboardList, managerOnly: true },
  { id: "assigned", label: "My Assigned Orders", icon: ClipboardList, waiterOnly: true },
  { id: "kitchen", label: "Kitchen Display", icon: ChefHat, notWaiterOnly: true },
  { id: "menu", label: "Menu Management", icon: BookOpen, managerOnly: true },
  { id: "tables", label: "Tables & QR Codes", icon: QrCode, managerOnly: true },
  { id: "customers", label: "Customer Management", icon: Users, managerOnly: true },
  { id: "analytics", label: "Analytics", icon: BarChart3, managerOnly: true },
  { id: "history", label: "Order History", icon: Activity, managerOnly: true },
  { id: "staff", label: "Staff Management", icon: Users, managerOnly: true, ownerOnly: true },
  { id: "settings", label: "Restaurant Settings", icon: Settings2, managerOnly: true, ownerOnly: true },
  { id: "notifications", label: "Notifications", icon: CircleHelp, managerOnly: true },
  { id: "activity", label: "Activity Logs", icon: ShieldCheck, managerOnly: true },
];

function cloudinaryFolderSegment(value: string, fallback: string) {
  return value.normalize("NFKC").replace(/[^\p{L}\p{N} _-]/gu, "").trim().replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 80) || fallback;
}

function cloudinaryCropUrl(imageUrl: string, crop: { x: number; y: number; width: number; height: number }) {
  const uploadPath = "/image/upload/";
  const uploadIndex = imageUrl.indexOf(uploadPath);
  if (uploadIndex < 0) throw new Error("Could not prepare the Cloudinary crop. Try uploading the image from your device.");
  const transformation = `c_crop,x_${crop.x},y_${crop.y},w_${crop.width},h_${crop.height}`;
  const splitAt = uploadIndex + uploadPath.length;
  return `${imageUrl.slice(0, splitAt)}${transformation}/${imageUrl.slice(splitAt)}`;
}

function staffRoleLabel(role: StaffRole) {
  if (role === "owner") return "Restaurant owner";
  if (role === "manager") return "Restaurant manager";
  if (role === "kitchen") return "Kitchen team";
  return "Service staff";
}

export default function AdminConsole({ shopId: routeShopId }: { shopId?: string }) {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<StaffRole | null>(null);
  const [restaurantId, setRestaurantId] = useState("");
  const [restaurantName, setRestaurantName] = useState("");
  const [authReady, setAuthReady] = useState(!firebaseConfigured);
  const [section, setSection] = useState<Section>("overview");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [accountName, setAccountName] = useState("");
  const [creatingAccount, setCreatingAccount] = useState(false);
  const [accountCreated, setAccountCreated] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [servedOrderNotice, setServedOrderNotice] = useState<AdminOrder | null>(null);
  const [whatsappBillMessage, setWhatsappBillMessage] = useState("");
  const [printBillOrder, setPrintBillOrder] = useState<AdminOrder | null>(null);
  const [collectedPaymentMethod, setCollectedPaymentMethod] = useState<"cash" | "upi" | "card">("cash");
  const [newOrderNotice, setNewOrderNotice] = useState<{ id: string; ticketId: string; tableNumber: string; customerName: string; customerPhone: string; paymentTiming: "prepaid" | "pay_after_serve"; paymentMethod: "upi" | "pay_after_serve" } | null>(null);
  const [servedIssueNotice, setServedIssueNotice] = useState<{ id: string; ticketId: string; tableNumber: string; customerName: string; customerPhone: string } | null>(null);
  const [assignedOrders, setAssignedOrders] = useState<WaiterOrder[]>([]);
  const [orderError, setOrderError] = useState("");
  const [tables, setTables] = useState<TableRecord[]>([]);
  const [tableId, setTableId] = useState("");
  const [tableNumber, setTableNumber] = useState("");
  const [tableMessage, setTableMessage] = useState("");
  const [tableError, setTableError] = useState("");
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [menuMessage, setMenuMessage] = useState("");
  const [menuError, setMenuError] = useState("");
  const [menuImportRows, setMenuImportRows] = useState<MenuImportRow[]>([]);
  const [menuImportFileName, setMenuImportFileName] = useState("");
  const [staff, setStaff] = useState<StaffRecord[]>([]);
  const [activity, setActivity] = useState<Record<string, unknown>[]>([]);
  const [settings, setSettings] = useState<RestaurantSettings | null>(null);
  const [subscriptionNoticeData, setSubscriptionNoticeData] = useState<SubscriptionNoticeData | null>(null);
  const [etaValues, setEtaValues] = useState<Record<string, string>>({});
  const [categoryName, setCategoryName] = useState("");
  const [itemEditorOpen, setItemEditorOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<MenuItem | null>(null);
  const [itemName, setItemName] = useState("");
  const [itemDescription, setItemDescription] = useState("");
  const [itemCategory, setItemCategory] = useState("");
  const [itemPrice, setItemPrice] = useState("");
  const [itemDiet, setItemDiet] = useState<"veg" | "non-veg">("veg");
  const [itemImage, setItemImage] = useState<File | null>(null);
  const [itemImageCloudinaryUrl, setItemImageCloudinaryUrl] = useState("");
  const [imageSourceMode, setImageSourceMode] = useState<"local" | "link">("local");
  const [imageUrlInput, setImageUrlInput] = useState("");
  const [loadingRemoteImage, setLoadingRemoteImage] = useState(false);
  const [cropSource, setCropSource] = useState<DishCropSource | null>(null);
  const [cropOpen, setCropOpen] = useState(false);
  const [removeItemImage, setRemoveItemImage] = useState(false);
  const [itemImagePreview, setItemImagePreview] = useState("");
  const [itemVariants, setItemVariants] = useState("");
  const [itemAddOns, setItemAddOns] = useState("");
  const [staffEmail, setStaffEmail] = useState("");
  const [staffRole, setStaffRole] = useState<StaffRole>("kitchen");
  const qrCanvas = useRef<HTMLCanvasElement | null>(null);
  const observedOrderIds = useRef<Set<string> | null>(null);
  const observedOrderStatuses = useRef<Map<string, OrderStatus> | null>(null);
  const observedServedIssueIds = useRef<Set<string> | null>(null);
  const remoteImageAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!itemImage) { setItemImagePreview(""); return; }
    const previewUrl = URL.createObjectURL(itemImage);
    setItemImagePreview(previewUrl);
    return () => URL.revokeObjectURL(previewUrl);
  }, [itemImage]);

  useEffect(() => {
    if (!firebaseConfigured) return;
    const { auth } = getFirebase();
    return onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      setRole(null);
      setRestaurantId("");
      setRestaurantName("");
      setMenuImportRows([]); setMenuImportFileName(""); setMenuError(""); setMenuMessage("");
      setOrders([]); setAssignedOrders([]); setStaff([]); setAuthError("");
      setNewOrderNotice(null); setServedIssueNotice(null); setServedOrderNotice(null); observedOrderIds.current = null; observedOrderStatuses.current = null; observedServedIssueIds.current = null;
      if (nextUser) {
        try {
          await nextUser.reload();
          if (routeShopId) {
            const access = await runFirebaseAction<{ shopId: string }, { role: StaffRole; shopName: string }>("getMyShopAccess", { shopId: routeShopId });
            setRestaurantId(routeShopId);
            setRestaurantName(access.shopName);
            setRole(access.role);
            setSection(access.role === "waiter" ? "assigned" : access.role === "kitchen" ? "kitchen" : "overview");
          }
        } catch (error) { setAuthError(errorMessage(error)); }
      }
      setAuthReady(true);
    });
  }, [routeShopId]);

  useEffect(() => {
    if (!user || !restaurantId || !role) return;
    const { db } = getFirebase();
    observedOrderIds.current = null;
    observedOrderStatuses.current = null;
    observedServedIssueIds.current = null;
    const orderCollection = role === "waiter" ? "assignedOrders" : role === "kitchen" ? "kitchenOrders" : "orders";
    const orderSource = collection(db, "restaurants", restaurantId, orderCollection);
    const orderQuery = role === "waiter"
      ? query(orderSource, where("assignedStaffUid", "==", user.uid), orderBy("createdAt", "desc"), limit(200))
      : query(orderSource, orderBy("createdAt", "desc"), limit(200));
    const stopOrders = onSnapshot(orderQuery, (snapshot) => {
      if (role === "waiter") setAssignedOrders(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as WaiterOrder));
      else {
        if ((role === "owner" || role === "manager") && observedOrderIds.current) {
          const latestNewOrder = snapshot.docs.find((entry) => !observedOrderIds.current?.has(entry.id));
          if (latestNewOrder) {
            const data = latestNewOrder.data();
            setNewOrderNotice({ id: latestNewOrder.id, ticketId: String(data.ticketId ?? ""), tableNumber: String(data.tableNumberSnapshot ?? ""), customerName: String(data.customerName ?? "Guest"), customerPhone: String(data.customerPhone ?? ""), paymentTiming: data.paymentTiming === "pay_after_serve" ? "pay_after_serve" : "prepaid", paymentMethod: data.paymentMethod === "upi" ? "upi" : "pay_after_serve" });
          }
        }
        if ((role === "owner" || role === "manager") && observedOrderStatuses.current) {
          const latestServedOrder = snapshot.docs.find((entry) => entry.data().status === "served" && observedOrderStatuses.current?.get(entry.id) !== "served");
          if (latestServedOrder) setServedOrderNotice({ id: latestServedOrder.id, ...latestServedOrder.data() } as AdminOrder);
        }
        observedOrderStatuses.current = new Map(snapshot.docs.map((entry) => [entry.id, entry.data().status as OrderStatus]));
        const servedIssueIds = new Set(snapshot.docs.filter((entry) => entry.data().customerServedResponse?.response === "no" && !entry.data().serviceIssueResolvedAt).map((entry) => entry.id));
        if ((role === "owner" || role === "manager") && observedServedIssueIds.current) {
          const latestServedIssue = snapshot.docs.find((entry) => servedIssueIds.has(entry.id) && !observedServedIssueIds.current?.has(entry.id));
          if (latestServedIssue) {
            const data = latestServedIssue.data();
            setServedIssueNotice({ id: latestServedIssue.id, ticketId: String(data.ticketId ?? ""), tableNumber: String(data.tableNumberSnapshot ?? ""), customerName: String(data.customerName ?? "Guest"), customerPhone: String(data.customerPhone ?? "") });
          }
        }
        observedServedIssueIds.current = servedIssueIds;
        observedOrderIds.current = new Set(snapshot.docs.map((entry) => entry.id));
        setOrders(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as AdminOrder));
      }
    }, (error) => setOrderError(error.message));
    const stopCategories = onSnapshot(query(collection(db, "restaurants", restaurantId, "categories"), orderBy("sortOrder")), (snapshot) => {
      setCategories(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as MenuCategory));
    }, (error) => setMenuError(error.message));
    const stopItems = onSnapshot(query(collection(db, "restaurants", restaurantId, "menuItems"), orderBy("name")), (snapshot) => {
      setMenuItems(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as MenuItem));
    }, (error) => setMenuError(error.message));
    return () => { stopOrders(); stopCategories(); stopItems(); };
  }, [user, restaurantId, role]);

  useEffect(() => {
    if (!printBillOrder) return;
    const afterPrint = () => setPrintBillOrder(null);
    window.addEventListener("afterprint", afterPrint);
    const timer = window.setTimeout(() => window.print(), 80);
    return () => { window.removeEventListener("afterprint", afterPrint); window.clearTimeout(timer); };
  }, [printBillOrder]);

  useEffect(() => {
    if (!user || !restaurantId || !role || section !== "tables") return;
    refreshTables();
  }, [user, restaurantId, role, section]);

  useEffect(() => {
    if (!user || role !== "owner" || !restaurantId || section !== "notifications") return;
    runFirebaseAction<{ shopId: string }, SubscriptionNoticeData>("getSubscription", { shopId: restaurantId })
      .then(setSubscriptionNoticeData)
      .catch((error: unknown) => setAuthError(errorMessage(error)));
  }, [user, restaurantId, role, section]);

  useEffect(() => {
    if (!user || role !== "owner") return;
    let cancelled = false;
    runFirebaseAction<Record<string, never>, { staff: StaffRecord[] }>("listStaff", {})
      .then((result) => { if (!cancelled) setStaff(result.staff); })
      .catch((error: unknown) => { if (!cancelled) setAuthError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [user, role]);

  useEffect(() => {
    if (!user || !restaurantId || !role) return;
    if (section === "settings") runFirebaseAction<Record<string, never>, RestaurantSettings>("getRestaurantSettings", {}).then(setSettings).catch((error: unknown) => setAuthError(errorMessage(error)));
    if (section === "activity") {
      const { db } = getFirebase();
      return onSnapshot(query(collection(db, "restaurants", restaurantId, "auditLogs"), orderBy("createdAt", "desc"), limit(100)), (snapshot) => setActivity(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }))), (error) => setAuthError(error.message));
    }
  }, [user, restaurantId, role, section]);

  const selectedTable = tables.find((table) => table.id === tableId) ?? null;
  const filteredOrders = useMemo(() => {
    if (section === "history") return orders.filter((order) => order.status === "served" || order.status === "cancelled");
    if (section === "kitchen") return orders.filter((order) => ["queued", "accepted", "preparing", "ready"].includes(order.status));
    return orders.filter((order) => !["served", "cancelled"].includes(order.status));
  }, [orders, section]);
  const isManager = role === "owner" || role === "manager";
  const recentSales = orders.filter((order) => order.status === "served").reduce((sum, order) => sum + order.totalAmountPaise, 0);
  const latestOpen = orders.filter((order) => !["served", "cancelled"].includes(order.status));
  const needsAttention = latestOpen.filter((order) => order.status === "queued" || (order.status === "accepted" && !order.estimatedMinutes));
  const servedIssues = orders.filter((order) => order.status === "served" && order.customerServedResponse?.response === "no" && !order.serviceIssueResolvedAt);
  const quotaPercent = subscriptionNoticeData?.orderLimit ? Math.floor(subscriptionNoticeData.currentUsage * 100 / subscriptionNoticeData.orderLimit) : 0;
  const subscriptionNeedsAttention = Boolean(subscriptionNoticeData && (
    ["pending_payment", "past_due", "grace_period", "cancelled", "expired"].includes(subscriptionNoticeData.status)
    || (subscriptionNoticeData.orderLimit !== null && quotaPercent >= 80)
    || (subscriptionNoticeData.currentPeriodEndMs !== null && subscriptionNoticeData.currentPeriodEndMs <= Date.now())
  ));
  const customerRows = useMemo(() => {
    const customers = new Map<string, { name: string; phone: string; orderCount: number; valuePaise: number; lastVisit: Date | null }>();
    for (const order of orders) {
      if (!order.customerPhone) continue;
      const existing = customers.get(order.customerPhone) ?? { name: order.customerName ?? "Guest", phone: order.customerPhone, orderCount: 0, valuePaise: 0, lastVisit: null };
      existing.orderCount += 1;
      existing.valuePaise += order.totalAmountPaise;
      const date = order.createdAt?.toDate?.() ?? null;
      if (date && (!existing.lastVisit || date > existing.lastVisit)) existing.lastVisit = date;
      customers.set(order.customerPhone, existing);
    }
    return [...customers.values()].sort((left, right) => right.orderCount - left.orderCount);
  }, [orders]);
  const chartData = useMemo(() => {
    const dateKey = (date: Date) => {
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
      const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
      return `${part("year")}-${part("month")}-${part("day")}`;
    };
    const [year, month, day] = dateKey(new Date()).split("-").map(Number);
    const days = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(Date.UTC(year, month - 1, day - (6 - index), 12));
      return { key: date.toISOString().slice(0, 10), label: date.toLocaleDateString("en-IN", { weekday: "short", timeZone: "UTC" }), orders: 0, value: 0 };
    });
    for (const order of orders) {
      const created = order.createdAt?.toDate?.();
      if (!created) continue;
      const day = days.find((entry) => entry.key === dateKey(created));
      if (day) { day.orders += 1; day.value += order.totalAmountPaise; }
    }
    return days;
  }, [orders]);
  const analytics = useMemo(() => {
    const itemCounts = new Map<string, { quantity: number; valuePaise: number }>();
    const tablesByCount = new Map<string, number>();
    const prepTimes: number[] = [];
    for (const order of orders) {
      if (order.status !== "cancelled") {
        tablesByCount.set(order.tableNumberSnapshot, (tablesByCount.get(order.tableNumberSnapshot) ?? 0) + 1);
        for (const item of order.items) {
          const current = itemCounts.get(item.name) ?? { quantity: 0, valuePaise: 0 };
          current.quantity += item.quantity;
          current.valuePaise += item.lineTotalPaise;
          itemCounts.set(item.name, current);
        }
      }
      const queued = order.statusEvents?.find((event) => event.status === "queued")?.at?.toMillis?.();
      const ready = order.statusEvents?.find((event) => event.status === "ready")?.at?.toMillis?.();
      if (queued && ready && ready >= queued) prepTimes.push((ready - queued) / 60_000);
    }
    return {
      topItems: [...itemCounts.entries()].map(([name, values]) => ({ name, ...values })).sort((left, right) => right.quantity - left.quantity).slice(0, 5),
      tableCounts: [...tablesByCount.entries()].map(([tableNumber, count]) => ({ tableNumber, count })).sort((left, right) => right.count - left.count).slice(0, 8),
      averagePrepMinutes: prepTimes.length ? prepTimes.reduce((sum, value) => sum + value, 0) / prepTimes.length : null,
    };
  }, [orders]);

  async function refreshTables() {
    setTableError("");
    try {
      const result = await runFirebaseAction<Record<string, never>, { tables: TableRecord[] }>("listTables", {});
      setTables(result.tables);
      setTableId((current) => result.tables.some((table) => table.id === current) ? current : result.tables[0]?.id ?? "");
    } catch (error) { setTableError(errorMessage(error)); }
  }

  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setAuthError(""); setBusy(true);
    try { await signInWithEmailAndPassword(getFirebase().auth, email.trim(), password); }
    catch (error) { setAuthError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function createAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setAuthError(""); setAuthNotice("");
    if (accountName.trim().length < 2) { setAuthError("Enter your name."); return; }
    if (password.length < 8) { setAuthError("Use a password with at least 8 characters."); return; }
    if (password !== confirmPassword) { setAuthError("The passwords do not match."); return; }
    setBusy(true);
    try {
      const credential = await createUserWithEmailAndPassword(getFirebase().auth, email.trim().toLowerCase(), password);
      await updateProfile(credential.user, { displayName: accountName.trim() });
      await sendEmailVerification(credential.user);
      await signOut(getFirebase().auth);
      setPassword(""); setConfirmPassword(""); setCreatingAccount(false); setAccountCreated(true);
      setAuthNotice("Account created. Verify the email we sent, then sign in. Restaurant owners can create a shop from onboarding; staff access is assigned by a shop owner.");
    } catch (error) { setAuthError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function resendVerification() {
    if (!user) return;
    setBusy(true); setAuthError(""); setAuthNotice("");
    try { await sendEmailVerification(user); setAuthNotice(`Verification email sent to ${user.email ?? "your email"}. Verify it, then sign out and back in.`); }
    catch (error) { setAuthError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function doTableAction(action: string, operation: () => Promise<unknown>) {
    setTableError(""); setTableMessage(""); setBusy(true);
    try { await operation(); setTableMessage(action); await refreshTables(); }
    catch (error) { setTableError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function createTable(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = tableNumber.trim();
    if (!value) return;
    setTableError(""); setTableMessage(""); setBusy(true);
    try {
      const created = await runFirebaseAction<{ tableNumber: string }, { id: string; tableNumber: string; qrToken: string }>("createTable", { tableNumber: value });
      await refreshTables(); setTableId(created.id); setTableNumber(""); setTableMessage(`Table ${created.tableNumber} and its QR link are ready.`);
    } catch (error) { setTableError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function setOrderStatus(order: Pick<AdminOrder, "id">, status: OrderStatus) {
    setBusy(true); setOrderError("");
    try { await runFirebaseAction<{ orderId: string; status: OrderStatus }, { ok: true }>("setOrderStatus", { orderId: order.id, status }); }
    catch (error) { setOrderError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function resolveServedIssue(order: Pick<AdminOrder, "id">) {
    setBusy(true); setOrderError("");
    try {
      await runFirebaseAction<{ orderId: string }, { ok: true }>("resolveServedIssue", { orderId: order.id });
      if (servedIssueNotice?.id === order.id) setServedIssueNotice(null);
    }
    catch (error) { setOrderError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function markOrderPaid(order: Pick<AdminOrder, "id">, method: "cash" | "upi" | "card") {
    setBusy(true); setOrderError("");
    try { await runFirebaseAction<{ orderId: string; method: "cash" | "upi" | "card" }, { ok: true }>("markOrderPaid", { orderId: order.id, method }); }
    catch (error) { setOrderError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  function sendWhatsAppBill(order: AdminOrder) {
    setWhatsappBillMessage("");
    let phone = (order.customerPhone ?? "").replace(/\D/g, "");
    if (phone.startsWith("00")) phone = phone.slice(2);
    if (phone.length === 10) phone = `91${phone}`;
    else if (phone.length === 11 && phone.startsWith("0")) phone = `91${phone.slice(1)}`;
    if (phone.length < 10 || phone.length > 15) { setWhatsappBillMessage("Could not prepare the bill: add the guest’s WhatsApp number with country code, for example +91 98765 43210."); return; }

    const ticketUrl = `${window.location.origin}/track/${encodeURIComponent(order.ticketId)}`;
    const items = order.items.map((item) => `• ${item.quantity} × ${item.name}${item.selections?.length ? ` (${item.selections.join(", ")})` : ""} — ${money(item.lineTotalPaise)}`);
    const payment = order.paymentStatus === "pending" ? order.paymentMethod === "upi" ? "UPI sent · awaiting restaurant verification" : "Pay at restaurant after serving" : order.paymentStatus === "mock_paid" ? "Prepaid demo (no real payment collected)" : order.paymentStatus === "paid" ? `Paid${order.paymentMethod ? ` · ${order.paymentMethod.toUpperCase()}` : ""}` : "Payment status pending";
    const message = [
      `Hello ${order.customerName || "there"},`,
      `Thank you for dining at *${restaurantName || "our restaurant"}*!`,
      "",
      `*Bill · Ticket ${order.ticketId} · Table ${order.tableNumberSnapshot}*`,
      ...items,
      "",
      `Subtotal: ${money(order.subtotalPaise)}`,
      `Tax: ${money(order.taxPaise)}`,
      ...(order.serviceFeePaise > 0 ? [`Service fee: ${money(order.serviceFeePaise)}`] : []),
      `*Total: ${money(order.totalAmountPaise)}*`,
      `Payment: ${payment}`,
      "",
      `Track the order and confirm service: ${ticketUrl}`,
      "",
      "Enjoy your meal!",
    ].join("\n");
    const text = encodeURIComponent(message);
    const webUrl = `https://web.whatsapp.com/send?phone=${phone}&text=${text}`;
    window.location.assign(webUrl);
  }

  function sendEmailBill(order: AdminOrder) {
    setOrderError("");
    const enteredEmail = order.customerEmail || window.prompt("Enter the guest's email address to prepare the bill:");
    if (!enteredEmail) return;
    const recipient = enteredEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(recipient)) { setOrderError("Enter a valid guest email address to prepare the bill."); return; }
    const ticketUrl = `${window.location.origin}/track/${encodeURIComponent(order.ticketId)}`;
    const itemLines = order.items.map((item) => `  ${item.quantity} × ${item.name}${item.selections?.length ? ` (${item.selections.join(", ")})` : ""} — ${money(item.lineTotalPaise)}`);
    const payment = order.paymentStatus === "pending" ? order.paymentMethod === "upi" ? "UPI payment submitted; awaiting restaurant verification" : "Pay at restaurant after serving" : order.paymentStatus === "mock_paid" ? "Prepaid demo (no real payment collected)" : order.paymentStatus === "paid" ? `Paid${order.paymentMethod ? ` by ${order.paymentMethod.toUpperCase()}` : ""}` : "Payment status pending";
    const subject = `Your order bill from ${restaurantName || "Restaurant"} · ${order.ticketId}`;
    const body = [
      `Dear ${order.customerName || "Guest"},`,
      "",
      `Thank you for choosing ${restaurantName || "our restaurant"}! We hope you enjoyed your meal.`,
      "",
      "YOUR ORDER",
      `Ticket: ${order.ticketId}`,
      `Table: ${order.tableNumberSnapshot}`,
      ...itemLines,
      "",
      `Subtotal: ${money(order.subtotalPaise)}`,
      `Tax: ${money(order.taxPaise)}`,
      ...(order.serviceFeePaise > 0 ? [`Service fee: ${money(order.serviceFeePaise)}`] : []),
      `Total: ${money(order.totalAmountPaise)}`,
      `Payment: ${payment}`,
      "",
      `Track your order and confirm service: ${ticketUrl}`,
      "",
      "If you have any questions about this bill, reply to this email and our team will help.",
      "",
      "Warm regards,",
      restaurantName || "Restaurant team",
    ].join("\r\n");
    const encodedRecipient = encodeURIComponent(recipient).replace(/%40/gi, "@");
    window.location.assign(`mailto:${encodedRecipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
  }

  async function assignWaiter(order: AdminOrder, staffUid: string) {
    setBusy(true); setOrderError("");
    try {
      await runFirebaseAction<{ orderId: string; staffUid: string | null }, { ok: true }>("assignWaiterToOrder", { orderId: order.id, staffUid: staffUid || null });
      setOrders((current) => current.map((entry) => entry.id === order.id ? { ...entry, assignedStaffUid: staffUid || null } : entry));
    } catch (error) { setOrderError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function saveEta(order: AdminOrder) {
    const minutes = Number(etaValues[order.id] || order.estimatedMinutes || 15);
    setBusy(true); setOrderError("");
    try { await runFirebaseAction<{ orderId: string; estimatedMinutes: number }, { ok: true }>("setOrderEta", { orderId: order.id, estimatedMinutes: minutes }); }
    catch (error) { setOrderError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  function showItemEditor(item?: MenuItem) {
    setEditingItem(item ?? null); setItemName(item?.name ?? ""); setItemDescription(item?.description ?? ""); setItemCategory(item?.categoryId ?? categories.find((category) => category.isActive)?.id ?? "");
    setItemPrice(item ? String(item.pricePaise / 100) : ""); setItemDiet(item?.dietaryType ?? "veg"); setItemImage(null); setItemImageCloudinaryUrl(""); setImageSourceMode("local"); setImageUrlInput(""); setLoadingRemoteImage(false); setCropSource(null); setCropOpen(false); setRemoveItemImage(false);
    setItemVariants((item?.variants ?? []).map((choice) => `${choice.name}:${(choice.priceDeltaPaise ?? 0) / 100}`).join(", "));
    setItemAddOns((item?.addOns ?? []).map((choice) => `${choice.name}:${(choice.pricePaise ?? 0) / 100}`).join(", "));
    setItemEditorOpen(true); setMenuError(""); setMenuMessage("");
  }

  function closeItemEditor() {
    remoteImageAbort.current?.abort();
    remoteImageAbort.current = null;
    setLoadingRemoteImage(false);
    setItemEditorOpen(false);
    setCropOpen(false);
    setCropSource(null);
  }

  function selectItemImage(file?: File) {
    if (!file) return;
    setMenuError("");
    if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(file.type)) { setMenuError("Choose a JPG, PNG, or WebP image."); return; }
    if (file.size >= 5 * 1024 * 1024) { setMenuError("Choose an image smaller than 5 MB."); return; }
    setImageSourceMode("local");
    setCropSource({ kind: "file", file });
    setCropOpen(true);
  }

  async function loadImageFromUrl() {
    const rawUrl = imageUrlInput.trim();
    setMenuError("");
    if (itemName.trim().length < 2) { setMenuError("Enter the dish name before loading a link so the photo goes into the right Cloudinary folder."); return; }
    let sourceUrl: URL;
    try { sourceUrl = new URL(rawUrl); }
    catch { setMenuError("Paste a direct HTTPS link to a JPG, PNG, or WebP image."); return; }
    if (sourceUrl.protocol !== "https:" || sourceUrl.username || sourceUrl.password) { setMenuError("Use a public HTTPS image link without a username or password."); return; }
    if (sourceUrl.hostname === "localhost" || sourceUrl.hostname.endsWith(".localhost") || sourceUrl.hostname.endsWith(".local") || /^(127\.|10\.|192\.168\.|169\.254\.)/.test(sourceUrl.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(sourceUrl.hostname) || sourceUrl.hostname === "::1" || sourceUrl.hostname === "[::1]") {
      setMenuError("Use a public image link, not a local network address."); return;
    }

    const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME?.trim();
    const uploadPreset = process.env.NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET?.trim();
    if (!cloudName || !uploadPreset) { setMenuError("Set the Cloudinary cloud name and unsigned upload preset in .env.local before loading image links."); return; }
    if (!/^[a-z0-9-]+$/i.test(cloudName)) { setMenuError("The Cloudinary cloud name in .env.local is invalid."); return; }

    const controller = new AbortController();
    remoteImageAbort.current = controller;
    setLoadingRemoteImage(true);
    try {
      const folder = `${cloudinaryFolderSegment(restaurantName, "Restaurant")}/${restaurantId}/${cloudinaryFolderSegment(itemName.trim(), "Dish")}`;
      const formData = new FormData();
      formData.append("file", sourceUrl.toString());
      formData.append("upload_preset", uploadPreset);
      formData.append("folder", folder);
      formData.append("public_id", `Image-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`);
      const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`, { method: "POST", body: formData, signal: controller.signal });
      const uploaded = await response.json() as CloudinaryUploadResult;
      if (!response.ok) throw new Error(uploaded.error?.message || "Cloudinary could not retrieve that image link. Use a direct public image URL or upload from your device.");
      if (!uploaded.secure_url?.startsWith("https://")) throw new Error("Cloudinary did not return a secure image URL.");
      if (uploaded.bytes !== undefined && uploaded.bytes >= 5 * 1024 * 1024) throw new Error("Choose an image smaller than 5 MB.");
      if (uploaded.format && !new Set(["jpg", "jpeg", "png", "webp"]).has(uploaded.format.toLowerCase())) throw new Error("That link does not point to a JPG, PNG, or WebP image.");
      setImageSourceMode("link");
      setCropSource({ kind: "cloudinary", imageUrl: uploaded.secure_url });
      setCropOpen(true);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      const message = error instanceof TypeError
        ? "Could not reach Cloudinary. Check your connection, upload preset, and Cloudinary settings."
        : errorMessage(error);
      setMenuError(message);
    } finally {
      if (remoteImageAbort.current === controller) {
        remoteImageAbort.current = null;
        setLoadingRemoteImage(false);
      }
    }
  }

  function applyCroppedImage(result: DishCropResult) {
    if (result.kind === "file") {
      setItemImage(result.file);
      setItemImageCloudinaryUrl("");
    } else {
      setItemImage(null);
      setItemImageCloudinaryUrl(result.imageUrl);
    }
    setRemoveItemImage(false);
    setCropOpen(false);
    setCropSource(null);
    setMenuError("");
  }

  function parseChoices(source: string, kind: "variant" | "addOn") {
    return source.split(",").map((segment) => segment.trim()).filter(Boolean).map((segment) => {
      const [rawName, rawPrice = "0"] = segment.split(":");
      const amount = Number(rawPrice.trim());
      if (!rawName.trim() || !Number.isFinite(amount) || amount < 0) throw new Error("Options use the format Name:price, separated by commas.");
      return kind === "variant" ? { id: crypto.randomUUID(), name: rawName.trim(), priceDeltaPaise: Math.round(amount * 100) } : { id: crypto.randomUUID(), name: rawName.trim(), pricePaise: Math.round(amount * 100) };
    });
  }

  async function saveMenuItem(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMenuError(""); setMenuMessage(""); setBusy(true);
    try {
      if (!itemName.trim() || !itemCategory || !Number.isFinite(Number(itemPrice)) || Number(itemPrice) < 0) throw new Error("Enter a name, category, and valid rupee price.");
      let imageUrl = removeItemImage ? "" : itemImageCloudinaryUrl || editingItem?.imageUrl || "";
      if (itemImage) {
        if (itemImage.size >= 5 * 1024 * 1024) throw new Error("Choose an image smaller than 5 MB.");
        const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME?.trim();
        const uploadPreset = process.env.NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET?.trim();
        if (!cloudName || !uploadPreset) throw new Error("Set the Cloudinary cloud name and unsigned upload preset in .env.local before uploading photos.");
        if (!/^[a-z0-9-]+$/i.test(cloudName)) throw new Error("The Cloudinary cloud name in .env.local is invalid.");
        const folder = `${cloudinaryFolderSegment(restaurantName, "Restaurant")}/${restaurantId}/${cloudinaryFolderSegment(itemName.trim(), "Dish")}`;
        const formData = new FormData();
        formData.append("file", itemImage, "Image.jpg");
        formData.append("upload_preset", uploadPreset);
        formData.append("folder", folder);
        formData.append("public_id", `Image-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`);
        const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`, { method: "POST", body: formData });
        const uploaded = await response.json() as CloudinaryUploadResult;
        if (!response.ok) throw new Error(uploaded.error?.message || "Cloudinary could not upload this dish image.");
        if (!uploaded.secure_url?.startsWith("https://")) throw new Error("Cloudinary did not return a secure dish image URL.");
        imageUrl = uploaded.secure_url;
      }
      const payload = {
        itemId: editingItem?.id,
        name: itemName.trim(), description: itemDescription.trim(), categoryId: itemCategory,
        pricePaise: Math.round(Number(itemPrice) * 100), dietaryType: itemDiet, imageUrl,
        variants: parseChoices(itemVariants, "variant"), addOns: parseChoices(itemAddOns, "addOn"),
      };
      await runFirebaseAction<typeof payload, { id: string }>("saveMenuItem", payload);
      setItemEditorOpen(false); setCropOpen(false); setCropSource(null); setMenuMessage(`${itemName.trim()} saved to the live menu.`);
    } catch (error) { setMenuError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function createCategory(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!categoryName.trim()) return;
    setBusy(true); setMenuError(""); setMenuMessage("");
    try { await runFirebaseAction<{ name: string }, { id: string }>("createCategory", { name: categoryName.trim() }); setMenuMessage(`Category “${categoryName.trim()}” added.`); setCategoryName(""); }
    catch (error) { setMenuError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function readMenuImportFile(file?: File) {
    if (!file) return;
    setBusy(true); setMenuError(""); setMenuMessage(""); setMenuImportRows([]); setMenuImportFileName(file.name);
    try {
      const rows = await parseMenuImportFile(file);
      setMenuImportRows(rows);
      setMenuMessage(`${rows.length} menu items found in ${file.name}. Review the rows, then import them.`);
    } catch (error) {
      setMenuImportFileName("");
      setMenuError(errorMessage(error));
    } finally { setBusy(false); }
  }

  function updateMenuImportRow(rowId: string, patch: Partial<Omit<MenuImportRow, "id">>) {
    setMenuImportRows((current) => current.map((row) => row.id === rowId ? { ...row, ...patch } : row));
  }

  async function importMenuRows() {
    setBusy(true); setMenuError(""); setMenuMessage("");
    try {
      const result = await runFirebaseAction<{ rows: MenuImportRow[] }, { importedCount: number; createdCategories: number }>("importMenu", { rows: menuImportRows });
      setMenuMessage(`${result.importedCount} dishes imported${result.createdCategories ? ` and ${result.createdCategories} categories created` : ""}.`);
      setMenuImportRows([]); setMenuImportFileName("");
    } catch (error) { setMenuError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  function clearMenuImport() { setMenuImportRows([]); setMenuImportFileName(""); setMenuError(""); setMenuMessage(""); }

  async function setMenuAvailability(item: MenuItem) {
    setBusy(true); setMenuError("");
    try { await runFirebaseAction<{ itemId: string; isAvailable: boolean }, { ok: true }>("setMenuAvailability", { itemId: item.id, isAvailable: !item.isAvailable }); }
    catch (error) { setMenuError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function saveSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!settings) return;
    setBusy(true); setAuthError("");
    try {
      await runFirebaseAction<RestaurantSettings, { ok: true }>("saveRestaurantSettings", settings);
      setRestaurantName(settings.name.trim());
      setAuthError("");
    } catch (error) { setAuthError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function inviteStaff(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!staffEmail.trim()) return;
    setBusy(true); setAuthError(""); setAuthNotice("");
    try {
      const result = await runFirebaseAction<{ email: string; role: StaffRole }, { ok: true; invited?: boolean }>("setStaffRole", { email: staffEmail.trim().toLocaleLowerCase("en-US"), role: staffRole });
      setAuthNotice(result.invited ? "Invite saved in Firebase. The team member can verify their email and sign in to activate restaurant access." : "Staff role updated.");
      setStaffEmail(""); const staffResult = await runFirebaseAction<Record<string, never>, { staff: StaffRecord[] }>("listStaff", {}); setStaff(staffResult.staff);
    } catch (error) { setAuthError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function toggleStaff(person: StaffRecord) {
    setBusy(true); setAuthError("");
    try {
      await runFirebaseAction<{ email: string; role: StaffRole; isActive: boolean }, { ok: true }>("setStaffRole", { email: person.email ?? "", role: person.role, isActive: !person.isActive });
      const result = await runFirebaseAction<Record<string, never>, { staff: StaffRecord[] }>("listStaff", {});
      setStaff(result.staff);
    } catch (error) { setAuthError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  function tableQrUrl(table: TableRecord) { return buildTableQrUrl(restaurantId, table.qrToken); }

  async function downloadQr() {
    const canvas = qrCanvas.current;
    if (!canvas || !selectedTable) return;
    const link = document.createElement("a"); link.download = `tableserve-table-${selectedTable.tableNumber}.png`; link.href = canvas.toDataURL("image/png"); link.click();
  }

  async function copyQr() {
    if (!selectedTable) return;
    await navigator.clipboard.writeText(tableQrUrl(selectedTable)); setTableMessage("QR link copied.");
  }

  if (!firebaseConfigured) return <div className="staff-gate"><section className="panel"><div className="brand"><BrandMark /><span className="brand-name">TableServe</span></div><h1 style={{ fontSize: 28 }}>Connect Firebase to continue</h1><p className="muted">Add your Firebase Web App settings to .env.local. Admin actions stay unavailable until the project is configured.</p><Link className="btn btn-primary" to="/">Back to TableServe</Link></section></div>;

  if (!authReady) return <div className="loading" style={{ paddingTop: "25vh" }}>Checking staff access…</div>;
  if (!user) return <div className="admin-login-wrap"><form className="panel admin-login" onSubmit={creatingAccount ? createAccount : login}>
    <Link className="brand" to="/"><BrandMark /><span><span className="brand-name">TableServe</span><span className="brand-sub">Restaurant operations</span></span></Link>
    <h1>{creatingAccount ? "Create an account" : "Staff sign in"}</h1><p className="muted">{creatingAccount ? "Use your Email/Password account. Verify your email before the owner can assign access." : "Sign in with your restaurant’s Firebase Email/Password account."}</p>
    <div className="admin-form">
      {accountCreated && authNotice && <div className="notice">{authNotice}</div>}
      {creatingAccount && <label className="field-label">Your name<input className="field" required minLength={2} autoComplete="name" value={accountName} onChange={(event) => setAccountName(event.target.value)} /></label>}
      <label className="field-label">Email<input className="field" type="email" required autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label className="field-label">Password<input className="field" type="password" required minLength={creatingAccount ? 8 : 1} autoComplete={creatingAccount ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      {creatingAccount && <label className="field-label">Confirm password<input className="field" type="password" required minLength={8} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>}
      {authError && <div className="notice error">{authError}</div>}{authNotice && !accountCreated && <div className="notice">{authNotice}</div>}
      <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? (creatingAccount ? "Creating account…" : "Signing in…") : (creatingAccount ? "Create account & send verification" : "Sign in")}<ArrowRight size={15} /></button>
      <button className="btn btn-quiet" type="button" onClick={() => { setCreatingAccount((current) => !current); setAuthError(""); setAuthNotice(""); }}>{creatingAccount ? "Already have an account? Sign in" : "Create account"}</button>
    </div>
  </form></div>;
  if (!role || !restaurantId) {
    return <div className="staff-gate"><section className="panel"><div className="brand"><BrandMark /><span className="brand-name">Staff access required</span></div>
      <p className="muted">This account does not have access to shop {routeShopId || "yet"}. Shop owners assign staff after they create their restaurant. Platform administration requires a separately provisioned account role.</p>
      {!user.emailVerified && <button className="btn btn-soft" disabled={busy} onClick={resendVerification}>Resend verification email</button>}
      <div className="staff-gate-links"><Link className="btn btn-primary" to="/onboarding">Create a restaurant</Link><Link className="btn btn-soft" to="/master/login">Master Admin sign in</Link></div>
      {authError && <div className="notice error" style={{ marginTop: 12 }}>{authError}</div>}{authNotice && <div className="notice" style={{ marginTop: 12 }}>{authNotice}</div>}<button className="btn btn-quiet" style={{ marginTop: 12 }} onClick={() => signOut(getFirebase().auth)}><LogOut size={15} /> Sign out</button></section></div>;
  }

  const currentDishImage = itemImagePreview || itemImageCloudinaryUrl || (!removeItemImage ? editingItem?.imageUrl ?? "" : "");

  return <div className="admin-shell">
    <aside className="admin-sidebar"><Link className="brand admin-brand" to="/"><BrandMark /><span className="admin-brand-copy"><span className="brand-name">TableServe</span><span className="brand-sub">Restaurant Operations</span><span className="brand-restaurant-name" title={restaurantName}>{restaurantName || "Restaurant"}</span></span></Link>
      <span className="pill"><span className="status-dot" /> Live Firebase data</span>
      <nav className="admin-nav">{navItems.filter((item) => (!item.managerOnly || isManager) && (!item.ownerOnly || role === "owner") && (!item.waiterOnly || role === "waiter") && (!item.notWaiterOnly || role !== "waiter")).map((item) => { const Icon = item.icon; return <button key={item.id} className={section === item.id ? "active" : ""} onClick={() => setSection(item.id)}><Icon />{item.label}{item.id === "notifications" && servedIssues.length > 0 && <span className="nav-count">{servedIssues.length}</span>}</button>; })}</nav>
      <div className="admin-sidebar-foot"><strong>{user.displayName || user.email}</strong><br />{role.toUpperCase()} · {restaurantId}<br /><span className="locked-label"><span className="status-dot" /> Access is role checked</span></div>
    </aside>

    <main className="admin-main">
      <header className="admin-topbar">
        <div className="admin-topbar-brandline">
          <div className="admin-topbar-brand"><Link className="brand admin-mobile-brand" to="/"><BrandMark /><span><span className="brand-name">TableServe</span><span className="brand-sub">Restaurant Operations</span><span className="brand-restaurant-name" title={restaurantName}>{restaurantName || "Restaurant"}</span></span></Link><span className="eyebrow admin-workspace-label">Restaurant workspace</span></div>
          <div className="admin-topbar-actions"><span className="pill admin-live-pill"><span className="status-dot" /> Live Firebase data</span>{role === "owner" && <Link className="btn btn-soft btn-small admin-subscription-link" to={`/app/${restaurantId}/subscription`}>Subscription</Link>}<Link className="btn btn-quiet btn-small" to="/shops">Switch shop</Link><button className="btn btn-quiet btn-small" onClick={() => signOut(getFirebase().auth)}><LogOut size={14} /> Sign out</button></div>
        </div>
        <select className="admin-mobile-menu field" aria-label="Admin section" value={section} onChange={(event) => setSection(event.target.value as Section)}>{navItems.filter((item) => (!item.managerOnly || isManager) && (!item.ownerOnly || role === "owner") && (!item.waiterOnly || role === "waiter") && (!item.notWaiterOnly || role !== "waiter")).map((item) => <option key={item.id} value={item.id}>{item.label}{item.id === "notifications" && servedIssues.length > 0 ? ` (${servedIssues.length})` : ""}</option>)}</select>
      </header>
      <div className="admin-content">
        {whatsappBillMessage && <div className={`notice ${/could not|did not|needs|error|failed|blocked|country code/i.test(whatsappBillMessage) ? "error" : ""}`} role="status" style={{ marginBottom: 14 }}>{whatsappBillMessage}</div>}
        {newOrderNotice && (role === "owner" || role === "manager") && <div className="notice" role="status" aria-live="polite" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
          <div><strong>New order · Table {newOrderNotice.tableNumber} · {newOrderNotice.customerName}</strong><div>{newOrderNotice.customerPhone} · {newOrderNotice.ticketId} · {newOrderNotice.paymentMethod === "upi" ? "UPI payment awaiting verification" : "Pay at restaurant after serving"}</div></div>
          <div style={{ display: "flex", gap: 8 }}><button className="btn btn-primary btn-small" onClick={() => { setSection("orders"); setNewOrderNotice(null); }}>Open live order</button><button className="icon-button" aria-label="Dismiss new order notice" onClick={() => setNewOrderNotice(null)}><X size={15} /></button></div>
        </div>}
        {servedIssueNotice && (role === "owner" || role === "manager") && <div className="notice error" role="alert" aria-live="assertive" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
          <div><strong>Guest needs help · Table {servedIssueNotice.tableNumber}</strong><div>{servedIssueNotice.customerName} · {servedIssueNotice.ticketId}{servedIssueNotice.customerPhone ? ` · ${servedIssueNotice.customerPhone}` : ""}</div></div>
          <div style={{ display: "flex", gap: 8 }}><button className="btn btn-soft btn-small" onClick={() => { setSection("notifications"); setServedIssueNotice(null); }}>Open guest report <ArrowRight size={13} /></button><button className="icon-button" aria-label="Dismiss guest report notice" onClick={() => setServedIssueNotice(null)}><X size={15} /></button></div>
        </div>}
        {servedOrderNotice && (role === "owner" || role === "manager") && <div className="notice served-order-notice" role="status" aria-live="polite" style={{ marginBottom: 14 }}>
          <div><strong>Order served · Table {servedOrderNotice.tableNumberSnapshot}</strong><div>{servedOrderNotice.ticketId} · {servedOrderNotice.customerName ?? "Guest"} · {money(servedOrderNotice.totalAmountPaise)}</div></div>
          <div className="served-order-notice-actions"><button className="btn btn-primary btn-small" onClick={() => { setPrintBillOrder(servedOrderNotice); setServedOrderNotice(null); }}><Printer size={14} /> Print Bill</button><button className="btn btn-soft btn-small" onClick={() => sendEmailBill(servedOrderNotice)}><Mail size={14} />{servedOrderNotice.customerEmail ? "Email Bill" : "Enter email"}</button><button className="btn btn-soft btn-small" onClick={() => sendWhatsAppBill(servedOrderNotice)}><MessageCircle size={14} />WhatsApp Bill</button>{servedOrderNotice.paymentTiming === "pay_after_serve" && servedOrderNotice.paymentStatus === "pending" && <><select className="field" aria-label="Payment received by" value={collectedPaymentMethod} onChange={(event) => setCollectedPaymentMethod(event.target.value as "cash" | "upi" | "card")}><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option></select><button className="btn btn-soft btn-small" disabled={busy} onClick={() => void markOrderPaid(servedOrderNotice, collectedPaymentMethod)}>Mark paid</button></>}{servedOrderNotice.paymentMethod === "upi" && servedOrderNotice.paymentStatus === "pending" && <button className="btn btn-soft btn-small" disabled={busy} onClick={() => void markOrderPaid(servedOrderNotice, "upi")}>Confirm UPI paid</button>}<button className="icon-button" aria-label="Dismiss served order notice" onClick={() => setServedOrderNotice(null)}><X size={15} /></button></div>
        </div>}
        {section === "overview" && <>
          <div className="admin-title-row"><div><div className="eyebrow">Service at a glance</div><h1>Live Operations</h1><p>Recent orders from your restaurant’s live Firestore feed.</p></div><button className="btn btn-soft" onClick={() => setSection("orders")}><ClipboardList size={16} /> Open order queue</button></div>
          <div className="admin-grid">
            <Metric label="Open orders" value={latestOpen.length} detail="Across the latest 200 orders" />
            <Metric label="In queue" value={orders.filter((order) => order.status === "queued").length} detail="Waiting on manager review" />
            <Metric label="Preparing" value={orders.filter((order) => order.status === "preparing" || order.status === "accepted").length} detail="Accepted or in kitchen" />
            <Metric label="Served order value" value={money(recentSales)} detail="From served orders in this feed" />
          </div>
          {orderError && <div className="notice error" style={{ marginTop: 14 }}>{orderError}</div>}
          <div className="admin-columns"><section className="panel"><div className="panel-heading"><h2>Current order queue</h2><button className="btn btn-quiet btn-small" onClick={() => setSection("orders")}>View all</button></div><OrderList orders={orders.filter((order) => !["served", "cancelled"].includes(order.status)).slice(0, 4)} role={role} busy={busy} etaValues={etaValues} onEta={(id, value) => setEtaValues((current) => ({ ...current, [id]: value }))} saveEta={saveEta} changeStatus={setOrderStatus} staff={staff} assignWaiter={assignWaiter} canAssignWaiters={role === "owner"} printBill={(order) => setPrintBillOrder(order)} paymentMethod={collectedPaymentMethod} onPaymentMethodChange={setCollectedPaymentMethod} markPaid={markOrderPaid} sendWhatsAppBill={sendWhatsAppBill} sendEmailBill={sendEmailBill} /></section>
            <section className="panel"><div className="panel-heading"><h2>Orders · last 7 days</h2><span className="pill">Latest 200</span></div>{orders.length ? <div style={{ width: "100%", height: 230 }}><ResponsiveContainer><BarChart data={chartData}><CartesianGrid stroke="#f1ddd8" vertical={false} /><XAxis dataKey="label" tick={{ fill: "#755d5c", fontSize: 10 }} /><YAxis allowDecimals={false} tick={{ fill: "#755d5c", fontSize: 10 }} /><Tooltip /><Bar dataKey="orders" fill="#850d32" radius={[6, 6, 0, 0]} /></BarChart></ResponsiveContainer></div> : <div className="empty-state"><h3>No order data yet</h3><p>Orders will appear here when guests place them.</p></div>}</section></div>
        </>}

        {(section === "orders" || section === "history") && <>
          <div className="admin-title-row"><div><div className="eyebrow">{section === "history" ? "Completed and cancelled" : "Real time order feed"}</div><h1>{section === "history" ? "Order History" : "Live Orders"}</h1><p>Orders update automatically from Firestore. Customer phone details are restricted to staff.</p></div></div>
          {orderError && <div className="notice error" style={{ marginBottom: 14 }}>{orderError}</div>}
          <OrderList orders={filteredOrders} role={role} busy={busy} etaValues={etaValues} onEta={(id, value) => setEtaValues((current) => ({ ...current, [id]: value }))} saveEta={saveEta} changeStatus={setOrderStatus} staff={staff} assignWaiter={assignWaiter} canAssignWaiters={role === "owner"} printBill={(order) => setPrintBillOrder(order)} paymentMethod={collectedPaymentMethod} onPaymentMethodChange={setCollectedPaymentMethod} markPaid={markOrderPaid} sendWhatsAppBill={sendWhatsAppBill} sendEmailBill={sendEmailBill} />
        </>}

        {section === "assigned" && <>
          <div className="admin-title-row"><div><div className="eyebrow">Assigned to your account</div><h1>My Assigned Orders</h1><p>Only orders assigned to you by your restaurant owner or platform support appear here.</p></div><span className="pill">{assignedOrders.filter((order) => !["served", "cancelled"].includes(order.status)).length} open</span></div>
          {assignedOrders.filter((order) => !["served", "cancelled"].includes(order.status)).length === 0 ? <div className="empty-state"><h3>No assigned orders</h3><p>New orders assigned by your restaurant owner or platform support will show here.</p></div> : <div className="order-list">{assignedOrders.filter((order) => !["served", "cancelled"].includes(order.status)).map((order) => <article className="order-card" key={order.id}>
            <div className="order-card-head"><div><h3>Table {order.tableNumberSnapshot}</h3><div className="order-card-meta"><span>{order.ticketId}</span><span>{order.createdAt?.toDate?.().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) ?? "New order"}</span></div></div><span className="pill">{humanizeStatus(order.status)}</span><EtaCountdown expectedReadyAtMs={order.expectedReadyAt?.toDate?.().getTime() ?? null} estimatedMinutes={order.estimatedMinutes} status={order.status} /></div>
            <div className="order-food">{order.items.map((item, index) => <div className="order-food-row" key={`${item.name}-${index}`}><span>{item.quantity} × {item.name}{item.selections?.length ? ` · ${item.selections.join(", ")}` : ""}{item.specialInstructions ? ` · ${item.specialInstructions}` : ""}</span></div>)}</div>
            {order.status === "ready" && <button className="btn btn-primary btn-small" disabled={busy} onClick={() => setOrderStatus(order, "served")}>Mark served</button>}
          </article>)}</div>}
        </>}

        {section === "kitchen" && <>
          <div className="admin-title-row"><div><div className="eyebrow">Live kitchen pass</div><h1>Kitchen Display</h1><p>Open tickets sync with the restaurant order queue and guest tracking.</p></div><span className="pill"><span className="status-dot" /> {filteredOrders.length} open tickets</span></div>
          {orderError && <div className="notice error">{orderError}</div>}
          {filteredOrders.length === 0 ? <div className="empty-state"><h3>Kitchen is clear</h3><p>New guest orders will appear here immediately.</p></div> : <div className="admin-grid kitchen-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(245px,1fr))", alignItems: "start" }}>
            {(["queued", "accepted", "preparing", "ready"] as OrderStatus[]).map((status) => <section className="panel" key={status}><div className="panel-heading"><h2>{status === "queued" ? "New tickets" : humanizeStatus(status)}</h2><span className="pill">{filteredOrders.filter((order) => order.status === status).length}</span></div><div className="order-list">{filteredOrders.filter((order) => order.status === status).map((order) => <article className="order-card" key={order.id}><div className="order-card-head"><div><h3>Table {order.tableNumberSnapshot}</h3><div className="order-card-meta"><span>{order.ticketId}</span>{order.createdAt && <span>{order.createdAt.toDate().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>}</div></div><EtaCountdown expectedReadyAtMs={order.expectedReadyAt?.toDate?.().getTime() ?? null} estimatedMinutes={order.estimatedMinutes} status={order.status} /></div><div className="order-food">{order.items.map((item, index) => <div className="order-food-row" key={`${item.name}-${index}`}><span>{item.quantity} × {item.name}{item.selections?.length ? ` · ${item.selections.join(", ")}` : ""}</span></div>)}</div>{status === "accepted" && <button className="btn btn-primary btn-small" disabled={busy} onClick={() => setOrderStatus(order, "preparing")}>Start preparing</button>}{status === "preparing" && <button className="btn btn-primary btn-small" disabled={busy} onClick={() => setOrderStatus(order, "ready")}>Mark ready</button>}{status === "ready" && isManager && <button className="btn btn-soft btn-small" disabled={busy} onClick={() => setOrderStatus(order, "served")}>Mark served</button>}</article>)}</div></section>)}
          </div>}
        </>}

        {section === "tables" && <>
          <div className="admin-title-row"><div><div className="eyebrow">Floor orchestration · secure tokens</div><h1>Tables & QR Management</h1><p>Each table keeps a stable Firestore identity. QR codes resolve through revocable, unpredictable tokens.</p></div><span className="pill"><Table2 size={14} /> {tables.length} registered</span></div>
          {tableError && <div className="notice error" style={{ marginBottom: 13 }}>{tableError}</div>}{tableMessage && <div className="notice" style={{ marginBottom: 13 }}>{tableMessage}</div>}
          <section className="panel" style={{ marginBottom: 15 }}><form className="admin-form-row" onSubmit={createTable}><label className="field-label">Table number<input className="field" required maxLength={24} value={tableNumber} onChange={(event) => setTableNumber(event.target.value)} placeholder="e.g. 07" /></label><div style={{ display: "flex", alignItems: "end", gap: 9 }}><button className="btn btn-primary" type="submit" disabled={busy}><Plus size={16} /> Generate QR</button><button className="btn btn-quiet" type="button" onClick={refreshTables}><RefreshCw size={15} /> Refresh</button></div></form></section>
          {tables.length === 0 ? <div className="empty-state"><h3>No tables registered</h3><p>Add the restaurant’s first table. Its QR token and permanent table ID are created by Firebase.</p></div> : <div className="table-layout">
            <div className="table-cards">{tables.map((table) => <button className={`table-card ${table.id === selectedTable?.id ? "selected" : ""}`} key={table.id} onClick={() => { setTableId(table.id); setTableNumber(table.tableNumber); }}><div className="panel-heading"><h3>Table {table.tableNumber}</h3><span className={`status-dot ${table.isActive ? "" : "off"}`} /></div><p>{table.isActive ? "QR active · guest ordering available" : "Inactive · link revoked"}</p><span className="pill">{table.isActive ? "Active" : "Inactive"}</span></button>)}</div>
            {selectedTable && <section className="panel table-detail">
              <div className="panel-heading"><div><div className="eyebrow">Table inspector</div><h2>Table {selectedTable.tableNumber}</h2></div><span className={`pill ${selectedTable.isActive ? "" : "muted"}`}><span className={`status-dot ${selectedTable.isActive ? "" : "off"}`} />{selectedTable.isActive ? "QR active" : "Inactive"}</span></div>
              {selectedTable.isActive && <><div className="qr-wrap"><QRCodeCanvas ref={qrCanvas} value={tableQrUrl(selectedTable)} size={220} level="H" includeMargin /></div><div className="qr-link">{tableQrUrl(selectedTable)}</div><div className="table-detail-actions"><button className="btn btn-soft" onClick={copyQr}><Copy size={14} /> Copy link</button><button className="btn btn-soft" onClick={downloadQr}><Download size={14} /> Download PNG</button><button className="btn btn-primary" onClick={() => window.print()}><Printer size={14} /> Print table card</button><button className="btn btn-quiet" disabled={busy} onClick={() => doTableAction("A new token is active; the previous QR was revoked.", async () => { const result = await runFirebaseAction<{ tableId: string }, { qrToken: string }>("regenerateTableQr", { tableId: selectedTable.id }); setTables((current) => current.map((table) => table.id === selectedTable.id ? { ...table, qrToken: result.qrToken } : table)); })}><RefreshCw size={14} /> Regenerate QR</button></div></>}
              <form className="admin-form" style={{ marginTop: 15 }} onSubmit={(event) => { event.preventDefault(); doTableAction("Table number updated. Its QR remains linked to the same table.", () => runFirebaseAction<{ tableId: string; tableNumber: string }, { ok: true }>("renameTable", { tableId: selectedTable.id, tableNumber: tableNumber.trim() })); }}><label className="field-label">Edit table number<input className="field" required maxLength={24} value={tableNumber} onChange={(event) => setTableNumber(event.target.value)} /></label><button className="btn btn-soft btn-small" disabled={busy || tableNumber.trim() === selectedTable.tableNumber}>Save number</button></form>
              <button className={`btn ${selectedTable.isActive ? "btn-danger" : "btn-primary"}`} style={{ width: "100%", marginTop: 10 }} disabled={busy} onClick={() => doTableAction(selectedTable.isActive ? "Table deactivated and its QR token revoked." : "Table reactivated with a fresh QR token.", async () => { const result = await runFirebaseAction<{ tableId: string; isActive: boolean }, { qrToken?: string }>("setTableActive", { tableId: selectedTable.id, isActive: !selectedTable.isActive }); if (result.qrToken) setTables((current) => current.map((table) => table.id === selectedTable.id ? { ...table, qrToken: result.qrToken!, isActive: true } : table)); })}>{selectedTable.isActive ? <ToggleLeft size={16} /> : <ToggleRight size={16} />}{selectedTable.isActive ? "Deactivate table" : "Reactivate & issue QR"}</button>
              <div className="print-only"><div className="print-card"><BrandMark size={48} /><h1>TableServe</h1><p>{selectedTable.isActive ? `Scan to order · Table ${selectedTable.tableNumber}` : "This table QR is inactive"}</p>{selectedTable.isActive && <QRCodeCanvas value={tableQrUrl(selectedTable)} size={240} level="H" includeMargin />}</div></div>
            </section>}
          </div>}
        </>}

        {section === "menu" && <>
          <div className="admin-title-row"><div><div className="eyebrow">Live menu engine</div><h1>Menu & Categories</h1><p>Changes publish to guest menus from Firestore without a website deployment.</p></div><button className="btn btn-primary" onClick={() => showItemEditor()}><Plus size={16} /> Create dish</button></div>
          {(menuError || menuMessage) && <div className={`notice ${menuError ? "error" : ""}`} style={{ marginBottom: 13 }}>{menuError || menuMessage}</div>}
          <section className="panel menu-import-panel">
            <div className="panel-heading"><div><h2>Import a full menu</h2><small className="muted">Upload XLSX, CSV or a text based PDF. Scanned PDFs need OCR.</small></div><span className="pill">Up to 400 dishes</span></div>
            <label className="field-label">Menu file<input className="field" type="file" accept=".xlsx,.csv,.pdf,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy} onChange={(event) => { void readMenuImportFile(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} /></label>
            <p className="muted menu-import-help">For spreadsheets, use columns such as Category, Name, Price, Description and Dietary Type. Review extracted rows before adding them to the live menu. You can still add dishes manually.</p>
            {menuImportFileName && menuImportRows.length > 0 && <>
              <div className="panel-heading menu-import-preview-head"><strong>{menuImportFileName}</strong><span>{menuImportRows.length} rows to import</span></div>
              <div className="menu-import-preview">{menuImportRows.map((row) => <div className="menu-import-row" key={row.id}>
                <label className="field-label">Category<input className="field" value={row.category} maxLength={80} onChange={(event) => updateMenuImportRow(row.id, { category: event.target.value })} /></label>
                <label className="field-label">Dish name<input className="field" value={row.name} maxLength={100} onChange={(event) => updateMenuImportRow(row.id, { name: event.target.value })} /></label>
                <label className="field-label">Price (₹)<input className="field" type="number" min="0" step="0.01" value={row.priceRupees} onChange={(event) => updateMenuImportRow(row.id, { priceRupees: Number(event.target.value) })} /></label>
                <label className="field-label">Dietary type<select className="field" value={row.dietaryType} onChange={(event) => updateMenuImportRow(row.id, { dietaryType: event.target.value as MenuImportRow["dietaryType"] })}><option value="veg">Vegetarian</option><option value="non-veg">Non vegetarian</option></select></label>
                <label className="field-label menu-import-description">Description<input className="field" value={row.description} maxLength={500} onChange={(event) => updateMenuImportRow(row.id, { description: event.target.value })} /></label>
                <button className="icon-button menu-import-remove" type="button" title={`Remove ${row.name}`} aria-label={`Remove ${row.name}`} onClick={() => setMenuImportRows((current) => current.filter((item) => item.id !== row.id))}><X size={15} /></button>
              </div>)}</div>
              <div className="menu-import-actions"><button className="btn btn-quiet" disabled={busy} onClick={clearMenuImport}>Clear preview</button><button className="btn btn-primary" disabled={busy || !menuImportRows.length} onClick={() => void importMenuRows()}>{busy ? "Importing…" : `Import ${menuImportRows.length} dishes`}</button></div>
            </>}
          </section>
          <div className="admin-columns"><section className="panel"><div className="panel-heading"><h2>Menu items</h2><span className="pill">{menuItems.length}</span></div>
            {menuItems.length === 0 ? <div className="empty-state"><h3>Your menu is empty</h3><p>Add real dishes and categories here. Guest menus update as soon as you save.</p></div> : <div className="menu-admin-list">{menuItems.map((item) => <div className="menu-admin-row" key={item.id}>{item.imageUrl ? <img src={item.imageUrl} alt="" /> : <span className="menu-image-placeholder" />}<span><strong>{item.name}</strong><small>{money(item.pricePaise)} · {categories.find((category) => category.id === item.categoryId)?.name ?? "Uncategorised"} · {item.isAvailable ? "Available" : "Unavailable"}</small></span><span style={{ display: "flex", gap: 5 }}><button className="icon-button" title={item.imageUrl ? "Change dish photo" : "Add dish photo"} aria-label={item.imageUrl ? `Change ${item.name} photo` : `Add ${item.name} photo`} onClick={() => showItemEditor(item)}><ImagePlus size={15} /></button><button className="icon-button" title="Edit dish" aria-label={`Edit ${item.name}`} onClick={() => showItemEditor(item)}><Pencil size={14} /></button><button className="icon-button" title={item.isAvailable ? "Mark unavailable" : "Mark available"} onClick={() => setMenuAvailability(item)}>{item.isAvailable ? <ToggleRight size={17} /> : <ToggleLeft size={17} />}</button></span></div>)}</div>}
          </section><section className="panel"><div className="panel-heading"><h2>Categories</h2><span className="pill">{categories.length}</span></div><form className="admin-form" onSubmit={createCategory}><label className="field-label">New category<input className="field" value={categoryName} onChange={(event) => setCategoryName(event.target.value)} placeholder="e.g. Biryani & curries" required /></label><button className="btn btn-soft" disabled={busy}><Plus size={14} /> Add category</button></form><div className="activity-list" style={{ marginTop: 17 }}>{categories.map((category) => <div className="activity-row" key={category.id}><strong>{category.name}</strong><span className="muted">{category.isActive ? "Published" : "Hidden"}</span></div>)}</div></section></div>
        </>}

        {section === "analytics" && <>
          <div className="admin-title-row"><div><div className="eyebrow">Persisted order activity</div><h1>Analytics</h1><p>Actual values from the latest 200 orders loaded from Firestore. Order value is not confirmed collected revenue.</p></div></div>
          <div className="admin-grid"><Metric label="Loaded orders" value={orders.length} detail="Most recent records" /><Metric label="Open" value={latestOpen.length} detail="Not served or cancelled" /><Metric label="Served order value" value={money(recentSales)} detail="Not confirmed collected revenue" /><Metric label="Average prep time" value={analytics.averagePrepMinutes === null ? "—" : `${analytics.averagePrepMinutes.toFixed(1)} min`} detail="Queued to ready, completed records" /></div>
          <section className="panel" style={{ marginTop: 17 }}><div className="panel-heading"><h2>Orders per day</h2><span className="pill">Last 7 calendar days · latest 200</span></div>{orders.length ? <div style={{ width: "100%", height: 320 }}><ResponsiveContainer><BarChart data={chartData}><CartesianGrid stroke="#f1ddd8" vertical={false} /><XAxis dataKey="label" tick={{ fill: "#755d5c", fontSize: 11 }} /><YAxis allowDecimals={false} tick={{ fill: "#755d5c", fontSize: 10 }} /><Tooltip /><Bar dataKey="orders" fill="#850d32" radius={[6, 6, 0, 0]} /></BarChart></ResponsiveContainer></div> : <div className="empty-state"><h3>No saved orders yet</h3><p>Analytics will be calculated from real orders when the restaurant receives them.</p></div>}</section>
          <div className="admin-columns"><section className="panel"><div className="panel-heading"><h2>Top dishes</h2><span className="pill">Recent orders</span></div>{analytics.topItems.length ? <div className="activity-list">{analytics.topItems.map((item) => <div className="activity-row" key={item.name}><strong>{item.name}<small className="muted" style={{ display: "block", marginTop: 4 }}>{item.quantity} portions</small></strong><strong>{money(item.valuePaise)}</strong></div>)}</div> : <div className="empty-state"><h3>No dish data yet</h3><p>Saved orders will populate this list.</p></div>}</section><section className="panel"><div className="panel-heading"><h2>Orders by table</h2><span className="pill">Recent orders</span></div>{analytics.tableCounts.length ? <div className="activity-list">{analytics.tableCounts.map((table) => <div className="activity-row" key={table.tableNumber}><strong>Table {table.tableNumber}</strong><span>{table.count} orders</span></div>)}</div> : <div className="empty-state"><h3>No table data yet</h3><p>Table activity appears after guests order.</p></div>}</section></div>
        </>}

        {section === "customers" && <>
          <div className="admin-title-row"><div><div className="eyebrow">Guest records from saved orders</div><h1>Customer Management</h1><p>Recent customer details are grouped from the latest 200 orders and remain visible to managers only.</p></div><span className="pill">{customerRows.length} recent guests</span></div>
          <section className="panel"><div className="activity-list">{customerRows.map((customer) => <div className="activity-row" key={customer.phone}><span><strong>{customer.name}</strong><a className="muted" style={{ display: "block", marginTop: 3 }} href={`tel:${customer.phone}`}>{customer.phone}</a></span><span style={{ textAlign: "right" }}><strong>{customer.orderCount} {customer.orderCount === 1 ? "order" : "orders"} · {money(customer.valuePaise)}</strong><small className="muted" style={{ display: "block", marginTop: 3 }}>Last visit {customer.lastVisit?.toLocaleDateString() ?? "—"}</small></span></div>)}{!customerRows.length && <div className="empty-state"><h3>No guest records yet</h3><p>Customer details appear here after real orders are placed.</p></div>}</div></section>
        </>}

        {section === "staff" && <>
          <div className="admin-title-row"><div><div className="eyebrow">Owner-controlled access</div><h1>Staff Management</h1><p>Roles are checked against the restaurant's live staff and membership records.</p></div></div>
          {authError && <div className="notice error" style={{ marginBottom: 13 }}>{authError}</div>}
          {role !== "owner" ? <div className="notice">Only this restaurant's owner can change its staff roles.</div> : <section className="panel">
            <div className="notice" style={{ marginBottom: 16 }}>Staff must create an Email/Password account and verify it first. Enter the same email address they use to sign in; email matching ignores letter case and surrounding spaces.</div>
            <form className="admin-form staff-assignment-form" onSubmit={inviteStaff}>
              <label className="field-label">Verified staff email<input className="field" type="email" autoComplete="email" required value={staffEmail} onChange={(event) => setStaffEmail(event.target.value)} placeholder="person@restaurant.com" /></label>
              <fieldset className="staff-role-fieldset"><legend className="field-label">Staff category</legend><div className="staff-role-grid">
                {([ ["manager", "Restaurant manager", "Restaurant orders and daily operations"], ["kitchen", "Kitchen team", "Kitchen order queue and preparation status"], ["waiter", "Service staff", "Orders assigned to this staff member"] ] as const).map(([value, title, detail]) => <label className={`staff-role-option ${staffRole === value ? "selected" : ""}`} key={value}><input type="radio" name="staffRole" value={value} checked={staffRole === value} onChange={() => setStaffRole(value)} /><span><strong>{title}</strong><small>{detail}</small></span></label>)}
              </div></fieldset>
              <div><button className="btn btn-primary" disabled={busy}><Users size={15} /> Assign staff</button></div>
            </form>
            <div className="activity-list" style={{ marginTop: 20 }}>{staff.map((person) => {
              const activeAssignments = orders.filter((order) => order.assignedStaffUid === person.uid && !["served", "cancelled"].includes(order.status));
              const assignedSummary = activeAssignments.slice(0, 3).map((order) => `Table ${order.tableNumberSnapshot} · ${order.ticketId} (${humanizeStatus(order.status)})`).join(" | ");
              return <div className="activity-row" key={person.uid}><span><strong>{person.displayName || person.email || person.uid}</strong><small className="muted" style={{ display: "block", marginTop: 3 }}>{person.email || person.uid}</small>{person.role === "waiter" && <small className="muted" style={{ display: "block", marginTop: 3 }}>{activeAssignments.length ? `${activeAssignments.length} open assigned · ${assignedSummary}${activeAssignments.length > 3 ? ` · +${activeAssignments.length - 3} more` : ""}` : "No open orders assigned"}</small>}</span><span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><span className="pill">{staffRoleLabel(person.role)} · {person.isActive ? "Active" : "Disabled"}</span><button className={`btn btn-small ${person.isActive ? "btn-danger" : "btn-soft"}`} disabled={busy || person.email?.toLocaleLowerCase("en-US") === user.email?.toLocaleLowerCase("en-US")} onClick={() => toggleStaff(person)}>{person.isActive ? "Disable" : "Reactivate"}</button></span></div>;
            })}</div>
          </section>}
        </>}

        {section === "settings" && <>
          <div className="admin-title-row"><div><div className="eyebrow">Restaurant profile</div><h1>Settings</h1><p>Customer-visible name, order availability, and server-calculated fees.</p></div></div>
          <section className="panel whatsapp-share-settings"><div className="panel-heading"><h2><MessageCircle size={18} /> WhatsApp bills</h2><span className="pill">No setup needed</span></div><p className="muted">Make sure WhatsApp Web is signed in in this browser on this PC. Choose <strong>WhatsApp Bill</strong> on a served order; the number entered with that order and bill details will be prefilled. Review the message and press <strong>Send</strong> in WhatsApp Web.</p></section>
          {authError && <div className="notice error" style={{ marginBottom: 13 }}>{authError}</div>}
          {settings ? <form className="panel admin-form" style={{ maxWidth: 700 }} onSubmit={saveSettings}>
            <label className="field-label">Restaurant name<input className="field" required value={settings.name} onChange={(event) => setSettings({ ...settings, name: event.target.value })} /></label>
            <div className="admin-form-row"><label className="field-label">Tax rate (%)<input className="field" type="number" min="0" max="100" step="0.01" value={settings.taxRateBps / 100} onChange={(event) => setSettings({ ...settings, taxRateBps: Math.round(Number(event.target.value) * 100) })} /></label><label className="field-label">Service fee (₹)<input className="field" type="number" min="0" step="0.01" value={settings.serviceFeePaise / 100} onChange={(event) => setSettings({ ...settings, serviceFeePaise: Math.round(Number(event.target.value) * 100) })} /></label></div>
            <label className="choice-row"><span><strong>Accept guest orders</strong><small className="muted" style={{ display: "block", marginTop: 4 }}>Pause ordering without deactivating table QR codes.</small></span><input type="checkbox" checked={settings.isAcceptingOrders} onChange={(event) => setSettings({ ...settings, isAcceptingOrders: event.target.checked })} /></label>
            <section className="restaurant-payment-settings"><div><div className="eyebrow">Payment configuration</div><h2>Choose what guests can pay with</h2><p className="muted">At least one method must stay enabled. UPI QR payments go directly to your UPI account; staff confirms receipt manually.</p></div>
              <label className="choice-row"><span><strong>Pay at restaurant</strong><small className="muted" style={{ display: "block", marginTop: 4 }}>Guests order now and pay your staff after serving.</small></span><input type="checkbox" checked={settings.payAtRestaurantEnabled} onChange={(event) => setSettings({ ...settings, payAtRestaurantEnabled: event.target.checked })} /></label>
              <label className="choice-row"><span><strong>Direct UPI payment</strong><small className="muted" style={{ display: "block", marginTop: 4 }}>Show guests a QR and UPI-app link for your VPA. No payment gateway fee.</small></span><input type="checkbox" checked={settings.upiEnabled} onChange={(event) => setSettings({ ...settings, upiEnabled: event.target.checked })} /></label>
              {settings.upiEnabled && <div className="admin-form-row"><label className="field-label">Restaurant UPI ID / VPA<input className="field" required value={settings.upiId} onChange={(event) => setSettings({ ...settings, upiId: event.target.value.trim() })} placeholder="restaurant@upi" /></label><label className="field-label">Payee name<input className="field" required maxLength={80} value={settings.upiPayeeName} onChange={(event) => setSettings({ ...settings, upiPayeeName: event.target.value })} placeholder={settings.name || "Restaurant name"} /></label></div>}
            </section>
            <button className="btn btn-primary" disabled={busy}><Save size={15} /> Save settings</button>
          </form> : <div className="loading">Loading restaurant settings…</div>}
        </>}

        {section === "activity" && <>
          <div className="admin-title-row"><div><div className="eyebrow">Saved in Firestore</div><h1>Activity Logs</h1><p>Operational changes with staff identity and Firestore timestamps.</p></div></div>
          <section className="panel"><div className="activity-list">{activity.map((entry) => <div className="activity-row" key={String(entry.id)}><span><strong>{String(entry.action ?? "Activity")}</strong><small className="muted" style={{ display: "block", marginTop: 3 }}>{String(entry.actorEmail ?? entry.actorUid ?? "System")} · {String(entry.targetType ?? "")}</small></span><span className="muted">{(entry.createdAt as { toDate?: () => Date } | undefined)?.toDate?.().toLocaleString() ?? ""}</span></div>)}{!activity.length && <div className="empty-state"><h3>No activity recorded yet</h3><p>Table, menu, and order updates will be logged as staff make changes.</p></div>}</div></section>
        </>}

        {section === "notifications" && <>
          <div className="admin-title-row"><div><div className="eyebrow">Live operational notices</div><h1>Notifications</h1><p>Order notices come from the live Firestore queue. Restaurant settings are stored in Firebase.</p></div><span className="pill">{needsAttention.length + servedIssues.length + Number(subscriptionNeedsAttention)} need attention</span></div>
          {orderError && <div className="notice error" style={{ marginBottom: 13 }}>{orderError}</div>}
          {role === "owner" && subscriptionNeedsAttention && subscriptionNoticeData && <article className="order-card"><div className="order-card-head"><div><h3>Workspace plan needs attention</h3><div className="order-card-meta"><span>{subscriptionNoticeData.status.replaceAll("_", " ")}</span>{subscriptionNoticeData.orderLimit !== null && <span>{subscriptionNoticeData.currentUsage.toLocaleString("en-IN")} / {subscriptionNoticeData.orderLimit.toLocaleString("en-IN")} accepted orders ({quotaPercent}%)</span>}{subscriptionNoticeData.currentPeriodEndMs !== null && <span>Cycle end {new Date(subscriptionNoticeData.currentPeriodEndMs).toLocaleDateString("en-IN")}</span>}</div><p className="muted">Workspace access is stored in Firestore. There is no payment provider in this setup.</p></div><Link className="btn btn-soft btn-small" to={`/app/${restaurantId}/subscription`}>Open workspace plan <ArrowRight size={13} /></Link></div></article>}
          {servedIssues.length > 0 && <section style={{ marginBottom: 16 }}><div className="eyebrow" style={{ marginBottom: 9 }}>Guest reports · quick resolution</div><div className="order-list">{servedIssues.map((order) => <article className="order-card served-issue-card" key={order.id}><div className="order-card-head"><div><h3>Guest says this order was not served</h3><div className="order-card-meta"><span>{order.ticketId}</span><span>Table {order.tableNumberSnapshot}</span>{order.customerName && <span>{order.customerName}</span>}{order.customerPhone && <a href={`tel:${order.customerPhone}`}>{order.customerPhone}</a>}{order.customerServedResponse?.createdAt?.toDate?.() && <span>Reported {order.customerServedResponse.createdAt.toDate().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>}</div></div><span className="pill">Needs follow-up</span></div><div className="order-food">{order.items.map((item, index) => <div className="order-food-row" key={`${item.name}-${index}`}><span>{item.quantity} × {item.name}{item.selections?.length ? ` · ${item.selections.join(", ")}` : ""}</span></div>)}</div>{order.customerServedResponse?.details && <p className="served-issue-details"><strong>Guest note:</strong> {order.customerServedResponse.details}</p>}<div className="order-actions"><p className="muted" style={{ margin: 0 }}>Please check with the guest and resolve the missing order or delivery.</p><button className="btn btn-primary btn-small" disabled={busy} onClick={() => void resolveServedIssue(order)}>Mark resolved</button></div></article>)}</div></section>}
          {needsAttention.length ? <div className="order-list">{needsAttention.map((order) => <article className="order-card" key={order.id}><div className="order-card-head"><div><h3>{order.status === "queued" ? "New order waiting" : "Preparation estimate needed"}</h3><div className="order-card-meta"><span>{order.ticketId}</span><span>Table {order.tableNumberSnapshot}</span><span>{order.createdAt?.toDate?.().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span></div></div><button className="btn btn-soft btn-small" onClick={() => setSection("orders")}>Open order queue <ArrowRight size={13} /></button></div></article>)}</div> : !servedIssues.length && !subscriptionNeedsAttention && !(role === "owner" && !subscriptionNoticeData) ? <div className="empty-state"><h3>You’re all caught up</h3><p>New orders, missing estimates, and guest service reports will appear here.</p></div> : null}
        </>}
      </div>
    </main>

    {printBillOrder && <div className="print-only print-only-bill"><article className="bill-print-card">
      <header className="bill-print-header">
        <div className="bill-print-hero">
          <span className="bill-print-orb bill-print-orb-one" aria-hidden="true" /><span className="bill-print-orb bill-print-orb-two" aria-hidden="true" />
          <div className="bill-print-brandline"><span className="bill-print-mark"><ChefHat size={19} strokeWidth={1.8} /></span><span className="bill-print-kicker">MADE WITH LOVE · SERVED FRESH</span></div>
          <h1>{restaurantName || "Restaurant"}</h1><p className="bill-print-hero-caption">A little something delicious</p>
          <div className="bill-print-invoice-tag"><span>DINING INVOICE</span><strong>{printBillOrder.ticketId}</strong></div>
        </div>
        <p className="bill-print-thanks">We’re glad you’re here. Enjoy every bite!</p>
      </header>
      <div className="bill-print-meta"><div className="bill-print-meta-card"><span>TABLE</span><strong>{printBillOrder.tableNumberSnapshot}</strong></div><div className="bill-print-meta-card"><span>GUEST</span><strong>{printBillOrder.customerName || "Guest"}</strong></div><div className="bill-print-meta-card bill-print-meta-time"><span>ORDERED AT</span><strong>{printBillOrder.createdAt?.toDate?.().toLocaleString() ?? new Date().toLocaleString()}</strong></div></div>
      <section className="bill-print-items"><div className="bill-print-items-heading"><strong>YOUR ORDER</strong><span>{printBillOrder.items.reduce((sum, item) => sum + item.quantity, 0)} ITEMS</span></div>{printBillOrder.items.map((item, index) => <div className="bill-print-item" key={`${item.name}-${index}`}><span className="bill-print-quantity">{item.quantity}×</span><div className="bill-print-item-name"><strong>{item.name}</strong>{item.selections?.length ? <small>{item.selections.join(", ")}</small> : null}</div><strong className="bill-print-item-price">{money(item.lineTotalPaise)}</strong></div>)}</section>
      <div className="bill-print-totals"><div><span>Subtotal</span><strong>{money(printBillOrder.subtotalPaise)}</strong></div><div><span>Tax</span><strong>{money(printBillOrder.taxPaise)}</strong></div>{printBillOrder.serviceFeePaise > 0 && <div><span>Service fee</span><strong>{money(printBillOrder.serviceFeePaise)}</strong></div>}<div className="grand"><div><small>GRAND TOTAL</small><span>{printBillOrder.paymentStatus === "pending" ? printBillOrder.paymentMethod === "upi" ? "UPI awaiting confirmation" : "Pay at restaurant" : "Thank you!"}</span></div><strong>{money(printBillOrder.totalAmountPaise)}</strong></div></div>
      <p className={`bill-print-payment ${printBillOrder.paymentStatus === "pending" ? "due" : "paid"}`}>{printBillOrder.paymentStatus === "pending" ? printBillOrder.paymentMethod === "upi" ? "UPI RECEIVED · AWAITING VERIFICATION" : "PAYMENT DUE · Pay at restaurant" : printBillOrder.paymentStatus === "mock_paid" ? "PREPAID DEMO · No real payment collected" : `PAID · ${printBillOrder.paymentMethod ?? "Recorded"}`}</p>
      <div className="bill-print-qr"><div className="bill-print-qr-copy"><span className="bill-print-qr-kicker">YOUR ORDER, LIVE</span><strong>Stay in the loop</strong><span>Scan to see your order, follow its progress and confirm service.</span></div><QRCodeCanvas value={`${CUSTOMER_APP_ORIGIN}/track/${encodeURIComponent(printBillOrder.ticketId)}`} size={132} level="M" includeMargin /></div>
      <footer className="bill-print-footer"><span className="bill-print-footer-flourish">✳</span><strong>Thank you for dining with us</strong><small>Good food tastes even better together.</small></footer>
    </article></div>}

    {itemEditorOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeItemEditor(); }}><section className="modal-sheet" role="dialog" aria-modal="true" aria-label="Menu item editor"><div className="panel-heading"><div><div className="eyebrow">Guest menu</div><h2>{editingItem ? "Edit dish" : "Create a dish"}</h2></div><button className="icon-button" onClick={closeItemEditor}><X size={16} /></button></div>
      <form className="admin-form" onSubmit={saveMenuItem}><label className="field-label">Dish name<input className="field" required value={itemName} onChange={(event) => setItemName(event.target.value)} /></label><label className="field-label">Description<textarea className="field" rows={2} value={itemDescription} onChange={(event) => setItemDescription(event.target.value)} /></label>
        <div className="admin-form-row"><label className="field-label">Category<select className="field" required value={itemCategory} onChange={(event) => setItemCategory(event.target.value)}><option value="">Choose a category</option>{categories.filter((category) => category.isActive).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label className="field-label">Price (₹)<input className="field" type="number" min="0" step="0.01" required value={itemPrice} onChange={(event) => setItemPrice(event.target.value)} /></label></div>
        <div className="admin-form-row"><label className="field-label">Dietary type<select className="field" value={itemDiet} onChange={(event) => setItemDiet(event.target.value as "veg" | "non-veg")}><option value="veg">Vegetarian</option><option value="non-veg">Non-vegetarian</option></select></label><div className="field-label">Dish photograph<small className="muted">Choose a source, then crop before saving.</small><div className="dish-image-source-tabs" role="tablist" aria-label="Photo source"><button type="button" role="tab" aria-selected={imageSourceMode === "local"} className={imageSourceMode === "local" ? "active" : ""} onClick={() => setImageSourceMode("local")}>From device</button><button type="button" role="tab" aria-selected={imageSourceMode === "link"} className={imageSourceMode === "link" ? "active" : ""} onClick={() => setImageSourceMode("link")}>From link</button></div><div className="dish-image-field">{currentDishImage ? <img className="dish-image-preview" src={currentDishImage} alt={`${itemName || "Dish"} preview`} /> : <span className="dish-image-empty"><ImagePlus size={20} /></span>}{imageSourceMode === "local" ? <div className="dish-image-actions"><label className="btn btn-soft btn-small dish-image-upload"><ImagePlus size={14} />{currentDishImage ? "Choose another" : "Upload photo"}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { selectItemImage(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>{currentDishImage && <button className="btn btn-quiet btn-small" type="button" onClick={() => { setItemImage(null); setItemImageCloudinaryUrl(""); setRemoveItemImage(true); }}>Remove</button>}</div> : <div className="dish-image-link-controls"><input className="field" type="url" inputMode="url" value={imageUrlInput} onChange={(event) => setImageUrlInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void loadImageFromUrl(); } }} placeholder="https://site.com/dish.jpg" aria-label="Direct image URL" /><button className="btn btn-soft btn-small" type="button" disabled={loadingRemoteImage || !imageUrlInput.trim()} onClick={() => void loadImageFromUrl()}>{loadingRemoteImage ? "Loading…" : "Load & crop"}</button>{currentDishImage && <button className="btn btn-quiet btn-small" type="button" onClick={() => { setItemImage(null); setItemImageCloudinaryUrl(""); setRemoveItemImage(true); }}>Remove</button>}</div>}</div><small className="muted">JPG, PNG or WebP · under 5 MB · square crop</small>{imageSourceMode === "link" && <small className="muted">Cloudinary fetches the public image link; you can crop it after it loads.</small>}</div></div>
        <label className="field-label">Variants <small className="muted">Comma separated Name:₹delta · e.g. Family:350</small><input className="field" value={itemVariants} onChange={(event) => setItemVariants(event.target.value)} placeholder="Regular:0, Family:350" /></label>
        <label className="field-label">Add-ons <small className="muted">Comma separated Name:₹price · e.g. Raita:60</small><input className="field" value={itemAddOns} onChange={(event) => setItemAddOns(event.target.value)} placeholder="Garlic raita:60, Shahi gravy:90" /></label>
        {menuError && <div className="notice error">{menuError}</div>}<button className="btn btn-primary" disabled={busy || loadingRemoteImage || cropOpen}><Save size={15} /> {busy ? "Saving…" : "Save to live menu"}</button>
      </form>
    </section></div>}
    {cropOpen && cropSource && <DishImageCropper source={cropSource} onApply={applyCroppedImage} onCancel={() => { setCropOpen(false); setCropSource(null); }} />}
  </div>;
}

function Metric({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return <article className="metric-card"><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

type CropDimensions = { width: number; height: number };
type CropOffset = { x: number; y: number };
const CROP_VIEWPORT_SIZE = 256;

function cropImageScale(dimensions: CropDimensions, zoom: number) {
  return Math.max(CROP_VIEWPORT_SIZE / dimensions.width, CROP_VIEWPORT_SIZE / dimensions.height) * zoom;
}

function clampCropOffset(offset: CropOffset, dimensions: CropDimensions, zoom: number): CropOffset {
  const scale = cropImageScale(dimensions, zoom);
  const maxX = Math.max(0, (dimensions.width * scale - CROP_VIEWPORT_SIZE) / 2);
  const maxY = Math.max(0, (dimensions.height * scale - CROP_VIEWPORT_SIZE) / 2);
  return { x: Math.min(maxX, Math.max(-maxX, offset.x)), y: Math.min(maxY, Math.max(-maxY, offset.y)) };
}

function DishImageCropper({ source, onApply, onCancel }: { source: DishCropSource; onApply: (result: DishCropResult) => void; onCancel: () => void }) {
  const [imageSrc, setImageSrc] = useState("");
  const [dimensions, setDimensions] = useState<CropDimensions | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<CropOffset>({ x: 0, y: 0 });
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const dragStart = useRef<{ x: number; y: number; offset: CropOffset } | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    setDimensions(null);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setError("");
    if (source.kind === "cloudinary") {
      setImageSrc(source.imageUrl);
      return;
    }
    const objectUrl = URL.createObjectURL(source.file);
    setImageSrc(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [source]);

  function applyCrop() {
    const image = imageRef.current;
    if (!image || !dimensions) return;
    const scale = cropImageScale(dimensions, zoom);
    const sourceLength = CROP_VIEWPORT_SIZE / scale;
    const sourceCenterX = (CROP_VIEWPORT_SIZE / 2 - offset.x) / scale;
    const sourceCenterY = (CROP_VIEWPORT_SIZE / 2 - offset.y) / scale;
    const sourceX = Math.min(dimensions.width - sourceLength, Math.max(0, sourceCenterX - sourceLength / 2));
    const sourceY = Math.min(dimensions.height - sourceLength, Math.max(0, sourceCenterY - sourceLength / 2));
    if (source.kind === "cloudinary") {
      const cropWidth = Math.max(1, Math.min(dimensions.width, Math.round(sourceLength)));
      const cropHeight = Math.max(1, Math.min(dimensions.height, Math.round(sourceLength)));
      const cropX = Math.min(dimensions.width - cropWidth, Math.max(0, Math.round(sourceX)));
      const cropY = Math.min(dimensions.height - cropHeight, Math.max(0, Math.round(sourceY)));
      onApply({ kind: "cloudinary", imageUrl: cloudinaryCropUrl(source.imageUrl, { x: cropX, y: cropY, width: cropWidth, height: cropHeight }) });
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext("2d");
    if (!context) { setError("Your browser could not crop this image. Try another browser or image."); return; }
    context.drawImage(image, sourceX, sourceY, sourceLength, sourceLength, 0, 0, canvas.width, canvas.height);
    setExporting(true);
    canvas.toBlob((blob) => {
      if (!blob) { setError("Could not create the cropped image. Please try again."); setExporting(false); return; }
      onApply({ kind: "file", file: new File([blob], "Image.jpg", { type: "image/jpeg", lastModified: Date.now() }) });
      setExporting(false);
    }, "image/jpeg", 0.9);
  }

  const scale = dimensions ? cropImageScale(dimensions, zoom) : 0;
  return createPortal(<div className="cropper-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <section className="cropper-sheet" role="dialog" aria-modal="true" aria-label="Crop dish image">
      <div className="panel-heading"><div><div className="eyebrow">Dish photo</div><h2>Crop image</h2></div><button className="icon-button" type="button" onClick={onCancel} aria-label="Cancel crop"><X size={16} /></button></div>
      <p className="cropper-help">Drag to position the dish, then adjust the zoom.</p>
      <div className="cropper-viewport" onPointerDown={(event) => { if (!dimensions) return; event.currentTarget.setPointerCapture(event.pointerId); dragStart.current = { x: event.clientX, y: event.clientY, offset }; }} onPointerMove={(event) => { if (!dragStart.current || !dimensions) return; setOffset(clampCropOffset({ x: dragStart.current.offset.x + event.clientX - dragStart.current.x, y: dragStart.current.offset.y + event.clientY - dragStart.current.y }, dimensions, zoom)); }} onPointerUp={(event) => { dragStart.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { dragStart.current = null; }}>
        {imageSrc && <img ref={imageRef} src={imageSrc} alt="Dish crop preview" draggable={false} onLoad={(event) => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setError("This image could not be opened. Choose another JPG, PNG, or WebP image.")} style={dimensions ? { width: dimensions.width * scale, height: dimensions.height * scale, left: `calc(50% + ${offset.x}px)`, top: `calc(50% + ${offset.y}px)` } : undefined} />}
        <span className="cropper-frame" aria-hidden="true" />
      </div>
      <label className="cropper-zoom">Zoom <input type="range" min="1" max="3" step="0.01" value={zoom} disabled={!dimensions} onChange={(event) => { const nextZoom = Number(event.target.value); setZoom(nextZoom); if (dimensions) setOffset((current) => clampCropOffset(current, dimensions, nextZoom)); }} /><span>{zoom.toFixed(1)}×</span></label>
      {error && <div className="notice error">{error}</div>}
      <div className="cropper-actions"><button className="btn btn-quiet" type="button" onClick={onCancel}>Cancel</button><button className="btn btn-primary" type="button" disabled={!dimensions || exporting || Boolean(error)} onClick={applyCrop}><ImagePlus size={15} />{exporting ? "Cropping…" : "Use cropped image"}</button></div>
    </section>
  </div>, document.body);
}

function OrderList({ orders, role, busy, etaValues, onEta, saveEta, changeStatus, staff, assignWaiter, canAssignWaiters, printBill, paymentMethod, onPaymentMethodChange, markPaid, sendWhatsAppBill, sendEmailBill }: {
  orders: AdminOrder[]; role: StaffRole; busy: boolean; etaValues: Record<string, string>;
  onEta: (id: string, value: string) => void; saveEta: (order: AdminOrder) => void;
  changeStatus: (order: AdminOrder, status: OrderStatus) => void;
  staff: StaffRecord[]; assignWaiter: (order: AdminOrder, staffUid: string) => void; canAssignWaiters: boolean;
  printBill: (order: AdminOrder) => void; paymentMethod: "cash" | "upi" | "card";
  onPaymentMethodChange: (method: "cash" | "upi" | "card") => void;
  markPaid: (order: Pick<AdminOrder, "id">, method: "cash" | "upi" | "card") => void;
  sendWhatsAppBill: (order: AdminOrder) => void; sendEmailBill: (order: AdminOrder) => void;
}) {
  if (!orders.length) return <div className="empty-state"><h3>No orders in this view</h3><p>New orders appear automatically as guests place them.</p></div>;
  return <div className="order-list">{orders.map((order) => <article className="order-card" key={order.id}>
    <div className="order-card-head"><div><h3>Table {order.tableNumberSnapshot} <span className="muted" style={{ font: "600 13px 'Plus Jakarta Sans'" }}>· {order.ticketId}</span></h3><div className="order-card-meta"><span>{order.customerName}</span>{role !== "kitchen" && order.customerPhone && <a href={`tel:${order.customerPhone}`}>{order.customerPhone}</a>}{role !== "kitchen" && order.customerEmail && <a href={`mailto:${order.customerEmail}`}>{order.customerEmail}</a>}{order.paymentMethod === "upi" && <span className="pill">{order.paymentStatus === "paid" ? "UPI paid" : "UPI · verify payment"}</span>}{order.paymentTiming === "pay_after_serve" && <span className="pill">{order.paymentStatus === "pending" ? "Payment due" : `Paid · ${order.paymentMethod ?? "recorded"}`}</span>}{order.paymentProvider === "mock" && <span className="pill">Demo payment · not charged</span>}<span>{order.createdAt?.toDate?.().toLocaleString() ?? "New order"}</span>{order.assignedStaffUid && <span>Assigned to {staff.find((person) => person.uid === order.assignedStaffUid)?.displayName || staff.find((person) => person.uid === order.assignedStaffUid)?.email || "service staff"}</span>}</div></div><span className="pill"><span className={`status-dot ${order.status === "cancelled" ? "off" : ""}`} />{humanizeStatus(order.status)}</span><EtaCountdown expectedReadyAtMs={order.expectedReadyAt?.toDate?.().getTime() ?? null} estimatedMinutes={order.estimatedMinutes} status={order.status} /></div>
    <div className="order-food">{order.items.map((item, index) => <div className="order-food-row" key={`${item.name}-${index}`}><span>{item.quantity} × {item.name}{item.selections?.length ? ` · ${item.selections.join(", ")}` : ""}{item.specialInstructions ? ` · “${item.specialInstructions}”` : ""}</span><strong>{money(item.lineTotalPaise)}</strong></div>)}<div className="order-food-row" style={{ borderTop: "1px solid #ecd9d5", marginTop: 5, paddingTop: 8 }}><strong>Total</strong><strong>{money(order.totalAmountPaise)}</strong></div></div>
    {role !== "kitchen" && !["served", "cancelled"].includes(order.status) && <div className="order-actions"><label className="field-label" style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6 }}>ETA <input className="field" type="number" min="1" max="240" placeholder="min" value={etaValues[order.id] ?? String(order.estimatedMinutes ?? "")} onChange={(event) => onEta(order.id, event.target.value)} /></label><button className="btn btn-soft btn-small" disabled={busy || !Number(etaValues[order.id] ?? order.estimatedMinutes)} onClick={() => saveEta(order)}><Save size={13} /> Save & notify</button>
      {canAssignWaiters && <label className="field-label">Service staff<select className="field" value={order.assignedStaffUid ?? ""} disabled={busy} onChange={(event) => assignWaiter(order, event.target.value)}><option value="">Unassigned</option>{staff.filter((person) => person.role === "waiter" && (person.isActive || person.uid === order.assignedStaffUid)).map((person) => <option key={person.uid} value={person.uid}>{person.displayName || person.email || person.uid}{person.isActive ? "" : " (disabled)"}</option>)}</select></label>}
      {order.status === "queued" && <button className="btn btn-primary btn-small" disabled={busy} onClick={() => changeStatus(order, "accepted")}>Accept</button>}
      {order.status === "accepted" && <button className="btn btn-primary btn-small" disabled={busy} onClick={() => changeStatus(order, "preparing")}>Preparing</button>}
      {order.status === "preparing" && <button className="btn btn-primary btn-small" disabled={busy} onClick={() => changeStatus(order, "ready")}>Mark ready</button>}
      {order.status === "ready" && <button className="btn btn-primary btn-small" disabled={busy} onClick={() => changeStatus(order, "served")}>Mark served</button>}
      {role === "owner" && ["queued", "accepted"].includes(order.status) && <button className="btn btn-danger btn-small" disabled={busy} onClick={() => changeStatus(order, "cancelled")}>Cancel</button>}
    </div>}
    {(role === "owner" || role === "manager") && order.paymentTiming === "prepaid" && order.paymentMethod === "upi" && order.paymentStatus === "pending" && order.status !== "cancelled" && <div className="order-actions"><span className="pill">Guest reports UPI paid · verify in restaurant account</span><button className="btn btn-soft btn-small" disabled={busy} onClick={() => markPaid(order, "upi")}>Confirm UPI received</button></div>}
    {order.status === "served" && <div className="order-actions"><button className="btn btn-primary btn-small" onClick={() => printBill(order)}><Printer size={14} /> Print Bill</button><button className="btn btn-soft btn-small" onClick={() => sendEmailBill(order)}><Mail size={14} />{order.customerEmail ? "Email Bill" : "Enter email"}</button><button className="btn btn-soft btn-small" onClick={() => sendWhatsAppBill(order)}><MessageCircle size={14} />WhatsApp Bill</button>{order.paymentTiming === "pay_after_serve" && order.paymentStatus === "pending" && <><label className="field-label">Payment received by<select className="field" value={paymentMethod} onChange={(event) => onPaymentMethodChange(event.target.value as "cash" | "upi" | "card")}><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option></select></label><button className="btn btn-soft btn-small" disabled={busy} onClick={() => markPaid(order, paymentMethod)}>Mark paid</button></>}</div>}
  </article>)}</div>;
}
