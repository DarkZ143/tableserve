import type React from 'react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { createUserWithEmailAndPassword, sendEmailVerification, sendPasswordResetEmail, signInWithEmailAndPassword, signOut, updateProfile, type User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { ArrowRight, Mail, Shield, UtensilsCrossed } from 'lucide-react';
import { BrandMark } from '../components/BrandMark';
import { claimPendingStaffInvites, runFirebaseAction } from '../lib/firebase-actions';
import { errorMessage } from '../lib/format';
import { firebaseConfigured, firebaseEmulatorsEnabled, getFirebase } from '../lib/firebase';
import type { StaffRole } from '../lib/types';

type Shop = { shopId: string; name: string; role: StaffRole };
function safeNextPath(value: string | null): string | null {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : null;
}
function Brand({ inverse = false }: { inverse?: boolean }) { return <Link className={`brand ${inverse ? "brand-inverse" : ""}`} to="/"><BrandMark /><span><span className="brand-name">TableServe</span><span className="brand-sub">Scan / Order / Dine</span></span></Link>; }

export function AuthPage({ masterOnly = false, register = false }: { masterOnly?: boolean; register?: boolean }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const nextPath = safeNextPath(searchParams.get('next'));
  const nextQuery = nextPath ? `?next=${encodeURIComponent(nextPath)}` : '';
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [verificationUser, setVerificationUser] = useState<User | null>(null);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    if (!firebaseConfigured) { setError("Firebase is not configured. Add the Firebase Web App settings in .env.local."); setBusy(false); return; }
    try {
      if (register) {
        if (name.trim().length < 2) throw new Error("Enter your name.");
        if (password.length < 8) throw new Error("Use a password with at least 8 characters.");
        const credential = await createUserWithEmailAndPassword(getFirebase().auth, email.trim().toLowerCase(), password);
        await updateProfile(credential.user, { displayName: name.trim() });
        await sendEmailVerification(credential.user);
        await signOut(getFirebase().auth);
        setPassword(""); setMessage(firebaseEmulatorsEnabled
          ? "Local account created. No email is sent in emulator mode; open the verification URL printed in the terminal running npm run emulators, then sign in."
          : `Account created. Verify the link sent to ${email.trim()}, then sign in to create your restaurant.`);
        return;
      }
      const credential = await signInWithEmailAndPassword(getFirebase().auth, email.trim().toLowerCase(), password);
      await credential.user.reload();
      if (!credential.user.emailVerified) { setVerificationUser(credential.user); setMessage("Verify your email before continuing. You can resend the verification message below."); return; }
      await credential.user.getIdToken(true);
      await claimPendingStaffInvites();
      const adminRecord = await getDoc(doc(getFirebase().db, "masterAdmins", credential.user.uid));
      if (masterOnly) {
        if (!adminRecord.exists() || adminRecord.data().active !== true || adminRecord.data().role !== "MasterAdmin") throw new Error("This account is not provisioned for Master Admin. Ask a project owner to enable access in Firestore.");
        await runFirebaseAction<Record<string, never>, unknown>("platformOverview", {});
        navigate("/master/dashboard", { replace: true });
        return;
      }
      if (adminRecord.exists() && adminRecord.data().active === true && adminRecord.data().role === "MasterAdmin") {
        await runFirebaseAction<Record<string, never>, unknown>("platformOverview", {});
        navigate("/master/dashboard", { replace: true });
        return;
      }
      if (nextPath) {
        navigate(nextPath, { replace: true });
        return;
      }
      const result = await runFirebaseAction<Record<string, never>, { shops: Shop[] }>("listMyRestaurants", {});
      if (result.shops.length > 1) navigate("/shops", { replace: true });
      else if (result.shops[0]) navigate(`/app/${result.shops[0].shopId}/dashboard`, { replace: true });
      else navigate("/onboarding", { replace: true });
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  async function resend() {
    if (!verificationUser) return;
    setBusy(true); setError("");
    try { await sendEmailVerification(verificationUser); setMessage(firebaseEmulatorsEnabled
      ? "Verification requested. Emulator mode does not send email; open the verification URL printed in the terminal running npm run emulators."
      : `Verification email sent to ${verificationUser.email}.`); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  return <main className="auth-shell"><section className="auth-aside"><Brand /><span className="eyebrow">{masterOnly ? "Platform operations" : register ? "Your restaurant, on its way" : "A better service flow"}</span><h1>{masterOnly ? <>The platform,<br /><em>thoughtfully run.</em></> : register ? <>Start with<br /><em>a warm welcome.</em></> : <>Your team,<br /><em>in rhythm.</em></>}</h1><p>{masterOnly ? "Manage restaurant workspaces, subscriptions and the plan catalog through a separately provisioned role." : "One account for the restaurants you own or the service teams you join."}</p><div className="auth-aside-foot"><span><Shield size={15} /> Email and password authentication</span><span><UtensilsCrossed size={15} /> Light mode · Warm hospitality</span></div></section><section className="auth-panel-wrap"><form className="panel auth-panel" onSubmit={submit}><Brand /><div className="eyebrow">{masterOnly ? "Secure administrator login" : register ? "Create your owner account" : "Welcome back"}</div><h2>{masterOnly ? "Master Admin" : register ? "Create an account" : "Sign in to TableServe"}</h2><p className="muted">{masterOnly ? "Only accounts provisioned by TableServe can enter this area. There is no Master Admin signup." : register ? "Use the email and password you will use for this workspace." : "Your staff role is checked against the restaurant selected after sign in."}</p>{register && firebaseEmulatorsEnabled && <div className="notice">Local testing: no email is sent. After signup, open the verification URL printed in the terminal running <code>npm run emulators</code>.</div>}{register && <label className="field-label">Your name<input className="field" required autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} /></label>}<label className="field-label">Email address<input className="field" type="email" required autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} /></label><label className="field-label">Password<input className="field" type="password" required minLength={register ? 8 : 1} autoComplete={register ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error && <div className="notice error">{error}</div>}{message && <div className="notice">{message}</div>}{verificationUser && <button className="btn btn-soft" type="button" onClick={resend} disabled={busy}>Resend verification email</button>}<button className="btn btn-primary auth-submit" disabled={busy}>{busy ? "Please wait…" : masterOnly ? "Sign in to Master Admin" : register ? "Create account & verify email" : "Sign in"}<ArrowRight size={15} /></button>{!register && !masterOnly && <Link className="auth-helper" to={`/forgot-password${nextQuery}`}>Forgot your password?</Link>}<p className="auth-switch">{masterOnly ? <Link to="/login">Restaurant or staff sign in</Link> : register ? <>Already registered? <Link to={`/login${nextQuery}`}>Sign in</Link></> : <>New to TableServe? <Link to={`/register${nextQuery}`}>Create an owner account</Link></>}</p></form></section></main>;
}

export function ForgotPasswordPage() {
  const [searchParams] = useSearchParams();
  const nextPath = safeNextPath(searchParams.get('next'));
  const nextQuery = nextPath ? `?next=${encodeURIComponent(nextPath)}` : '';
  const [email, setEmail] = useState(""); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) { event.preventDefault(); setMessage(""); setError(""); try { if (!firebaseConfigured) throw new Error("Firebase is not configured."); await sendPasswordResetEmail(getFirebase().auth, email.trim().toLowerCase()); setMessage("If this address has a Firebase account, a password reset link has been sent."); } catch (reason) { setError(errorMessage(reason)); } }
  return <main className="simple-page"><form className="panel simple-form" onSubmit={submit}><Brand /><span className="eyebrow">Account recovery</span><h1>Reset your password.</h1><p className="muted">Enter the email address on your Firebase Email/Password account.</p><label className="field-label">Email address<input className="field" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>{error && <div className="notice error">{error}</div>}{message && <div className="notice">{message}</div>}<button className="btn btn-primary">Send reset link <Mail size={15} /></button><Link to={`/login${nextQuery}`} className="auth-helper">Return to sign in</Link></form></main>;
}

