import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  getCodeProblem,
  getDebugProblem,
  runCode,
  runDebugCode,
  saveDebugDraft,
  submitCode,
  submitDebugFix,
} from "@/lib/student.functions";
import { AppShell, STUDENT_NAV } from "@/components/AppShell";
import { CountdownTimer } from "@/components/CountdownTimer";
import { FloatingTimer } from "@/components/FloatingTimer";
import { useProctor } from "@/hooks/use-proctor";
import { useLiveSync } from "@/hooks/use-live-sync";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/_authenticated/problems/$problemId")({
  validateSearch: (search: Record<string, unknown>) => ({
    kind: search["kind"] === "debug" ? ("debug" as const) : ("code" as const),
  }),
  head: () => ({
    meta: [
      { title: "Problem — CodeArena" },
      { name: "description", content: "Solve the problem and submit your code for evaluation." },
      { property: "og:title", content: "Problem — CodeArena" },
      { property: "og:description", content: "Coding problem workspace on CodeArena." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ProblemPage,
});

function ProblemPage() {
  const { problemId } = Route.useParams();
  const { kind } = Route.useSearch();
  return kind === "debug" ? <DebugWorkspace problemId={problemId} /> : <CodeWorkspace problemId={problemId} />;
}

function DebugWorkspace({ problemId }: { problemId: string }) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState<string | null>(null);
  const [runOutput, setRunOutput] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["debug-problem", problemId],
    queryFn: () => getDebugProblem({ data: { problemId } }),
    refetchInterval: 20_000,
  });
  const data = q.data;
  const value = code ?? data?.savedCode ?? "";
  const canPlay = Boolean(data?.canPlay);
  const roundId = data?.problem.roundId ?? null;
  const proctor = useProctor(roundId, canPlay);
  const sync = useLiveSync(roundId);
  const remaining = sync.round?.remainingSeconds ?? data?.remainingSeconds ?? 0;
  const roundState = sync.round?.state ?? data?.round.state ?? "DRAFT";
  useEffect(() => {
    void q.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roundState]);

  // The server owns the clock; we only render a local countdown from it.
  const endsAt = useMemo(
    () =>
      remaining > 0 ? new Date(Date.now() + remaining * 1000).toISOString() : null,
    [remaining, data?.status],
  );

  // Autosave the draft so a refresh or navigation never loses work.
  useEffect(() => {
    if (code === null || !canPlay) return;
    const id = setTimeout(() => {
      saveDebugDraft({ data: { problemId, sourceCode: code } }).catch(() => undefined);
    }, 1200);
    return () => clearTimeout(id);
  }, [code, canPlay, problemId]);

  const run = useMutation({
    mutationFn: () => runDebugCode({ data: { problemId, sourceCode: value } }),
    onSuccess: (result) => {
      setRunOutput(result.error ? `${result.status}: ${result.error}` : result.output || "(no output)");
      toast.message(`${result.status} · ${result.durationMs} ms`);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not run your code."),
  });
  const submit = useMutation({
    mutationFn: () => submitDebugFix({ data: { problemId, sourceCode: value } }),
    onSuccess: (result) => {
      toast.success(result.message || "Submission evaluated.");
      queryClient.invalidateQueries({ queryKey: ["debug-problem", problemId] });
      queryClient.invalidateQueries({ queryKey: ["round-play"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not submit your fix."),
  });

  return (
    <AppShell nav={STUDENT_NAV} title={data?.problem.title ?? "Bug Hunt"} subtitle="Fix every bug you can find.">
      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError || !data ? (
        <p className="text-sm text-destructive">
          {q.error instanceof Error ? q.error.message : "Could not load this problem."}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="font-mono text-sm">
              {data.fixedBugs}/{data.totalBugs} bugs fixed · {data.earned}/{data.problem.marks} marks
            </p>
            <CountdownTimer endsAt={endsAt} onExpire={() => q.refetch()} />
          </div>

          {canPlay ? (
            <FloatingTimer
              serverSeconds={remaining}
              state={roundState}
              label="Time left"
              paused={roundState === "PAUSED"}
              onExpire={() => void q.refetch()}
            />
          ) : null}
          {canPlay && !proctor.fullscreen ? (
            <Button size="sm" variant="outline" className="mt-3" onClick={proctor.requestFullscreen}>
              Enter fullscreen
            </Button>
          ) : null}

          <p className="mt-4 whitespace-pre-wrap text-sm text-muted-foreground">{data.problem.description}</p>

          <h2 className="mt-6 text-sm font-semibold">Bugs to find</h2>
          <div className="mt-3 space-y-2">
            {data.bugs.map((bug) => (
              <div
                key={bug.id}
                className="surface flex items-center justify-between gap-3 rounded-lg border border-border/70 px-4 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {bug.bugCode} · {bug.title}
                  </p>
                  {bug.description ? (
                    <p className="truncate text-xs text-muted-foreground">{bug.description}</p>
                  ) : null}
                </div>
                <Badge variant={bug.awarded ? "default" : "secondary"}>
                  {bug.awarded ? `Fixed · ${bug.marks}` : `${bug.marks} marks`}
                </Badge>
              </div>
            ))}
            {data.bugs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No bugs configured for this problem yet.</p>
            ) : null}
          </div>

          <Textarea
            className="mt-6 min-h-80 font-mono text-xs"
            value={value}
            onChange={(event) => setCode(event.target.value)}
            disabled={!canPlay}
            spellCheck={false}
          />

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button variant="secondary" disabled={!canPlay || run.isPending} onClick={() => run.mutate()}>
              {run.isPending ? "Running…" : "Run / Check"}
            </Button>
            <Button disabled={!canPlay || submit.isPending} onClick={() => submit.mutate()}>
              {submit.isPending ? "Evaluating…" : "Submit fix"}
            </Button>
            <span className="text-xs text-muted-foreground">
              Running never awards marks. Submitting awards each bug only the first time it is fixed.
            </span>
          </div>

          {runOutput !== null ? (
            <pre className="surface mt-4 max-h-56 overflow-auto rounded-lg border border-border/70 p-4 font-mono text-xs">
              {runOutput}
            </pre>
          ) : null}

          {!canPlay ? (
            <p className="mt-3 text-sm text-muted-foreground">
              {data.gate.reason || "This round is not open for you right now."}
            </p>
          ) : null}

          {data.submissions.length ? (
            <>
              <h2 className="mt-10 text-sm font-semibold">Your submissions</h2>
              <div className="mt-3 space-y-2">
                {data.submissions.map((s) => (
                  <div
                    key={s.id}
                    className="surface flex items-center justify-between gap-4 rounded-lg border border-border/70 px-4 py-2"
                  >
                    <p className="min-w-0 truncate text-xs text-muted-foreground">
                      {new Date(s.createdAt).toLocaleTimeString()} · {s.message}
                    </p>
                    <span className="font-mono text-sm">+{s.score}</span>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </>
      )}
    </AppShell>
  );
}


function CodeWorkspace({ problemId }: { problemId: string }) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState<string | null>(null);
  const [language, setLanguage] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["code-problem", problemId],
    queryFn: () => getCodeProblem({ data: { problemId } }),
  });

  const data = q.data;
  const value = code ?? data?.problem.starterCode ?? "";
  const lang = language ?? data?.languages[0] ?? "javascript";
  const codeProctor = useProctor(data?.problem.roundId ?? null, Boolean(data?.canPlay));
  const codeSync = useLiveSync(data?.problem.roundId ?? null);
  const codeRemaining = codeSync.round?.remainingSeconds ?? data?.remainingSeconds ?? 0;
  const codeRoundState = codeSync.round?.state ?? data?.round.state ?? "DRAFT";
  useEffect(() => {
    void q.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeRoundState]);

  const trial = useMutation({
    mutationFn: () => runCode({ data: { problemId, language: lang, code: value } }),
    onSuccess: (result) => toast.message(`${result.status}: ${result.message}`),
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not run your code."),
  });
  const submit = useMutation({
    mutationFn: () => submitCode({ data: { problemId, language: lang, code: value } }),
    onSuccess: (result) => {
      toast.success(`${result.status} · ${result.passed}/${result.total} tests`);
      queryClient.invalidateQueries({ queryKey: ["code-problem", problemId] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not submit your code."),
  });

  return (
    <AppShell nav={STUDENT_NAV} title={data?.problem.title ?? "Problem"} subtitle="Code Sprint workspace.">
      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError || !data ? (
        <p className="text-sm text-destructive">
          {q.error instanceof Error ? q.error.message : "Could not load this problem."}
        </p>
      ) : (
        <>
          {data.canPlay ? (
            <FloatingTimer
              serverSeconds={codeRemaining}
              state={codeRoundState}
              label="Time left"
              paused={codeRoundState === "PAUSED"}
              onExpire={() => void q.refetch()}
            />
          ) : null}
          {data.canPlay && !codeProctor.fullscreen ? (
            <Button size="sm" variant="outline" className="mb-4" onClick={codeProctor.requestFullscreen}>
              Enter fullscreen
            </Button>
          ) : null}
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{data.problem.description}</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="surface rounded-lg border border-border/70 p-4">
              <p className="mono-label text-muted-foreground">Input</p>
              <p className="mt-2 whitespace-pre-wrap text-xs">{data.problem.inputFormat || "—"}</p>
            </div>
            <div className="surface rounded-lg border border-border/70 p-4">
              <p className="mono-label text-muted-foreground">Output</p>
              <p className="mt-2 whitespace-pre-wrap text-xs">{data.problem.outputFormat || "—"}</p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {data.languages.map((option) => (
              <Button
                key={option}
                size="sm"
                variant={lang === option ? "default" : "outline"}
                onClick={() => setLanguage(option)}
              >
                {option}
              </Button>
            ))}
          </div>

          <Textarea
            className="mt-4 min-h-80 font-mono text-xs"
            value={value}
            onChange={(event) => setCode(event.target.value)}
            disabled={!data.canPlay}
          />

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              disabled={!data.canPlay || trial.isPending}
              onClick={() => trial.mutate()}
            >
              {trial.isPending ? "Running…" : "Run sample tests"}
            </Button>
            <Button disabled={!data.canPlay || submit.isPending} onClick={() => submit.mutate()}>
              {submit.isPending ? "Submitting…" : "Submit"}
            </Button>
            <span className="text-xs text-muted-foreground">
              {data.hiddenTestCount} hidden test(s) · {data.problem.marks} marks
            </span>
          </div>
          {!data.canPlay ? <p className="mt-3 text-sm text-muted-foreground">{data.gate.reason}</p> : null}

          <div className="mt-8 space-y-2">
            {data.submissions.map((s) => (
              <div
                key={s.id}
                className="surface flex items-center justify-between rounded-lg border border-border/70 px-5 py-3"
              >
                <span className="text-xs text-muted-foreground">
                  {s.language} · {s.passedTests}/{s.totalTests} · {new Date(s.createdAt).toLocaleTimeString()}
                </span>
                <span className="font-mono text-sm">
                  {s.status} · {s.score}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </AppShell>
  );
}
