import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { getEventControl, saveEventSettings } from "@/lib/admin-manage.functions";
import { AppShell, ADMIN_NAV } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_authenticated/admin/settings")({
  head: () => ({
    meta: [
      { title: "Settings — CodeArena admin" },
      { name: "description", content: "Event title, proctoring limits, autosave timing and the continuation password." },
      { property: "og:title", content: "Settings — CodeArena admin" },
      { property: "og:description", content: "Configuration for the coding competition." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminSettings,
});

function AdminSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["event-control"], queryFn: () => getEventControl() });

  const [title, setTitle] = useState("");
  const [limit, setLimit] = useState(3);
  const [debounce, setDebounce] = useState(1500);
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (!q.data) return;
    setTitle(q.data.event?.title ?? "");
    setLimit(q.data.settings?.fullscreenViolationLimit ?? 3);
    setDebounce(q.data.settings?.autosaveDebounceMs ?? 1500);
  }, [q.data]);

  const save = useMutation({
    mutationFn: () =>
      saveEventSettings({
        data: {
          title,
          fullscreenViolationLimit: limit,
          autosaveDebounceMs: debounce,
          ...(password ? { continuationPassword: password } : {}),
        },
      }),
    onSuccess: () => {
      toast.success("Settings saved.");
      setPassword("");
      void qc.invalidateQueries({ queryKey: ["event-control"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save settings."),
  });

  return (
    <AppShell nav={ADMIN_NAV} title="Settings" subtitle="Applies to the whole event immediately.">
      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError ? (
        <p className="text-sm text-destructive">Could not load settings.</p>
      ) : (
        <div className="surface max-w-xl rounded-lg border border-border/70 p-6">
          <div className="grid gap-5">
            <div className="grid gap-2">
              <Label htmlFor="title">Event title</Label>
              <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="limit">Fullscreen violation limit</Label>
              <Input
                id="limit"
                type="number"
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                A student is locked out of the round after this many proctoring violations.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="debounce">Autosave delay (ms)</Label>
              <Input
                id="debounce"
                type="number"
                value={debounce}
                onChange={(e) => setDebounce(Number(e.target.value))}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cont">Continuation password</Label>
              <Input
                id="cont"
                type="password"
                autoComplete="new-password"
                placeholder={
                  q.data?.settings?.continuationPasswordSet ? "Set — leave blank to keep" : "Not set yet"
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Invigilators type this to let a locked-out student back into their round.
              </p>
            </div>
            <div>
              <Button disabled={save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? "Saving…" : "Save settings"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
