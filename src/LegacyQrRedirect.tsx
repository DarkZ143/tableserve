import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { BrandMark } from "../components/BrandMark";
import { runFirebaseAction } from "../lib/firebase-actions";
import { errorMessage } from "../lib/format";

export default function LegacyQrRedirect() {
  const { qrToken = "" } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    runFirebaseAction<{ token: string }, { shopId: string }>("resolveLegacyTableQr", { token: qrToken })
      .then((result) => { if (!cancelled) navigate(`/t/${result.shopId}/${qrToken}`, { replace: true }); })
      .catch((reason: unknown) => { if (!cancelled) setError(errorMessage(reason)); });
    return () => { cancelled = true; };
  }, [qrToken, navigate]);
  return <main className="simple-page"><section className="panel simple-form"><Link className="brand" to="/"><BrandMark /><span><span className="brand-name">TableServe</span><span className="brand-sub">Scan / Order / Dine</span></span></Link><span className="eyebrow">Updating your table link</span><h1>{error ? "This QR link is unavailable." : "Opening your table…"}</h1><p className="muted">{error || "We’re moving this existing table QR to its restaurant-scoped address."}</p>{error && <Link className="btn btn-primary" to="/">Return home</Link>}</section></main>;
}
