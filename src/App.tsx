import { lazy, Suspense } from "react";
import { Link, Route, Routes, useParams } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { BrandMark } from "../components/BrandMark";

const LandingPage = lazy(() => import("./MarketingPages").then((module) => ({ default: module.LandingPage })));
const PricingPage = lazy(() => import("./MarketingPages").then((module) => ({ default: module.PricingPage })));
const AuthPage = lazy(() => import("./AuthPages").then((module) => ({ default: module.AuthPage })));
const ForgotPasswordPage = lazy(() => import("./AuthPages").then((module) => ({ default: module.ForgotPasswordPage })));
const ShopsPage = lazy(() => import("./RestaurantPages").then((module) => ({ default: module.ShopsPage })));
const OnboardingPage = lazy(() => import("./RestaurantPages").then((module) => ({ default: module.OnboardingPage })));
const BillingPage = lazy(() => import("./RestaurantPages").then((module) => ({ default: module.BillingPage })));
const AdminConsole = lazy(() => import("../components/AdminConsole"));
const CustomerFlow = lazy(() => import("../components/CustomerFlow"));
const TrackingView = lazy(() => import("../components/TrackingView"));
const MasterAdminPage = lazy(() => import("./MasterAdminPage"));
const LegacyQrRedirect = lazy(() => import("./LegacyQrRedirect"));

function Brand({ inverse = false }: { inverse?: boolean }) {
  return <Link className={`brand ${inverse ? "brand-inverse" : ""}`} to="/"><BrandMark /><span><span className="brand-name">TableServe</span><span className="brand-sub">Scan · Order · Dine</span></span></Link>;
}

function AdminRoute() { const { shopId } = useParams(); return <AdminConsole key={shopId} shopId={shopId} />; }
function CustomerRoute() { const { shopId = "", qrToken = "" } = useParams(); return <CustomerFlow shopId={shopId} token={qrToken} />; }
function TicketRoute({ justPlaced = false }: { justPlaced?: boolean }) { const { ticketId } = useParams(); return <TrackingView ticketId={ticketId ? decodeURIComponent(ticketId) : undefined} justPlaced={justPlaced} />; }

function NotFoundPage() { return <main className="simple-page"><section className="panel simple-form"><Brand /><span className="eyebrow">Page unavailable</span><h1>We couldn't find that page.</h1><Link className="btn btn-primary" to="/">Return home <ArrowRight size={15} /></Link></section></main>; }

export default function App() {
  return <Suspense fallback={<div className="loading" style={{ paddingTop: "20vh" }}>Loading TableServe…</div>}><Routes>
    <Route path="/" element={<LandingPage />} />
    <Route path="/pricing" element={<PricingPage />} />
    <Route path="/register" element={<AuthPage register />} />
    <Route path="/login" element={<AuthPage />} />
    <Route path="/forgot-password" element={<ForgotPasswordPage />} />
    <Route path="/onboarding" element={<OnboardingPage />} />
    <Route path="/shops" element={<ShopsPage />} />
    <Route path="/app/:shopId/*" element={<AdminRoute />} />
    <Route path="/app/:shopId/subscription" element={<BillingPage />} />
    <Route path="/t/:shopId/:qrToken/success/:ticketId" element={<TicketRoute justPlaced />} />
    <Route path="/t/:shopId/:qrToken/*" element={<CustomerRoute />} />
    <Route path="/t/:qrToken" element={<LegacyQrRedirect />} />
    <Route path="/track" element={<TrackingView />} />
    <Route path="/track/:ticketId" element={<TicketRoute />} />
    <Route path="/order/:ticketId" element={<TicketRoute justPlaced />} />
    <Route path="/master/login" element={<AuthPage masterOnly />} />
    <Route path="/master/*" element={<MasterAdminPage />} />
    <Route path="*" element={<NotFoundPage />} />
  </Routes></Suspense>;
}
