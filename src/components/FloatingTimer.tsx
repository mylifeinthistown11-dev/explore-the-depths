import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Fixed floating countdown. The server sends the authoritative number of
 * seconds left; this component only renders it and ticks locally between
 * refreshes. It never decides when a round is over — it asks the server.
 */
export function FloatingTimer({
  serverSeconds,
  state,
  label,
  onExpire,
  paused = false,
}: {
  serverSeconds: number;
  state: string;
  label: string;
  onExpire?: () => void;
  paused?: boolean;
}) {
  const [seconds, setSeconds] = useState(serverSeconds);
  const fired = useRef(false);

  useEffect(() => {
    setSeconds(serverSeconds);
    if (serverSeconds > 0) fired.current = false;
  }, [serverSeconds]);

  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => {
      setSeconds((s) => {
        const next = Math.max(0, s - 1);
        if (next === 0 && !fired.current) {
          fired.current = true;
          onExpire?.();
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(id);
    // onExpire may be a fresh closure each render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);

  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const urgent = seconds <= 120 && !paused;

  return (
    <div
      className={cn(
        "fixed bottom-5 right-5 z-[100] w-44 rounded-xl border p-4 shadow-2xl backdrop-blur",
        "bg-background/90",
        urgent ? "border-destructive/50" : "border-border/70",
      )}
      role="timer"
      aria-live="off"
    >
      <p className="mono-label text-[10px] tracking-widest text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 font-mono text-2xl font-bold tabular-nums",
          urgent ? "text-destructive" : "text-foreground",
        )}
      >
        {h > 0 ? `${String(h).padStart(2, "0")}:` : ""}
        {String(m).padStart(2, "0")}:{String(s).padStart(2, "0")}
      </p>
      <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span
          className={cn(
            "inline-block size-2 rounded-full",
            paused ? "bg-amber-500" : state === "LIVE" ? "animate-pulse bg-emerald-500" : "bg-muted-foreground",
          )}
        />
        {paused ? "PAUSED" : state}
      </p>
    </div>
  );
}
