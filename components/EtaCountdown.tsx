"use client";

import { useEffect, useState } from "react";
import { Clock3 } from "lucide-react";
import type { OrderStatus } from "@/lib/types";

export default function EtaCountdown({
  expectedReadyAtMs,
  estimatedMinutes,
  status,
}: {
  expectedReadyAtMs: number | null;
  estimatedMinutes: number | null;
  status: OrderStatus;
}) {
  const [nowMs, setNowMs] = useState<number | null>(null);
  const active = status === "queued" || status === "accepted" || status === "preparing";

  useEffect(() => {
    if (!active || expectedReadyAtMs === null || !Number.isFinite(expectedReadyAtMs)) return;
    setNowMs(Date.now());
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [active, expectedReadyAtMs]);

  if (!active) return null;
  if (expectedReadyAtMs === null || !Number.isFinite(expectedReadyAtMs) || nowMs === null) {
    return <span className="eta-countdown pending"><Clock3 size={13} />{estimatedMinutes ? `ETA · ${estimatedMinutes} min` : "ETA pending"}</span>;
  }

  const secondsRemaining = Math.ceil((expectedReadyAtMs - nowMs) / 1000);
  const overdue = secondsRemaining < 0;
  const absoluteSeconds = Math.abs(secondsRemaining);
  const time = `${String(Math.floor(absoluteSeconds / 60)).padStart(2, "0")}:${String(absoluteSeconds % 60).padStart(2, "0")}`;
  const totalMinutes = Math.floor(absoluteSeconds / 60);
  const remainingSeconds = absoluteSeconds % 60;

  return (
    <span
      className={`eta-countdown${overdue ? " overdue" : ""}`}
      role="timer"
      aria-label={`${totalMinutes} minutes and ${remainingSeconds} seconds ${overdue ? "overdue" : "remaining"}`}
      title={overdue ? "The estimated preparation time has passed" : "Time remaining until the estimated ready time"}
    >
      <Clock3 size={13} />
      {overdue ? "Overdue" : "Time left"}
      <strong>{time}</strong>
    </span>
  );
}
