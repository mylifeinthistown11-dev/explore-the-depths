import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getRoundPlay, saveAnswer, submitRound } from "@/lib/student.functions";
import { AppShell, STUDENT_NAV } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { FloatingTimer } from "@/components/FloatingTimer";
import { useProctor } from "@/hooks/use-proctor";
import { useLiveSync } from "@/hooks/use-live-sync";
import { useEffect } from "react";

export const Route = createFileRoute("/_authenticated/rounds/$roundId")({
  head: () => ({
    meta: [
      { title: "Round — CodeArena" },
      { name: "description", content: "Answer the round questions before the timer runs out." },
      { property: "og:title", content: "Round — CodeArena" },
      { property: "og:description", content: "Live competition round on CodeArena." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: RoundPage,
});

function formatTime(seconds: number) {
  const s = Math.max(0, seconds);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function RoundPage() {
  const { roundId } = Route.useParams();
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ["round-play", roundId],
    queryFn: () => getRoundPlay({ data: { roundId } }),
    refetchInterval: 5000,
  });

  const answer = useMutation({
    mutationFn: (input: { questionId: string; optionKey?: string; answerText?: string }) =>
      saveAnswer({ data: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["round-play", roundId] }),
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not save your answer."),
  });

  const finish = useMutation({
    mutationFn: () => submitRound({ data: { roundId } }),
    onSuccess: () => {
      toast.success("Round submitted.");
      queryClient.invalidateQueries({ queryKey: ["round-play", roundId] });
      queryClient.invalidateQueries({ queryKey: ["student-dashboard"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not submit the round."),
  });

  const data = q.data;
  const sync = useLiveSync(roundId);
  const liveRound = sync.round;
  // The clock and the state are the round's, issued by the server for everyone.
  const remaining = liveRound?.remainingSeconds ?? data?.remainingSeconds ?? 0;
  const roundState = liveRound?.state ?? data?.round.state ?? "DRAFT";
  const myStatus = sync.live?.myStatus[roundId] ?? data?.status;
  const canPlay = Boolean(data?.canPlay) && roundState === "LIVE";
  const paused = roundState === "PAUSED";
  const proctor = useProctor(roundId, canPlay);

  // Any admin action (start, pause, end, restart) or an expired clock reloads
  // the authoritative attempt immediately — no manual refresh.
  useEffect(() => {
    void q.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roundState, myStatus]);

  return (
    <AppShell
      nav={STUDENT_NAV}
      title={data?.round.name ?? "Round"}
      subtitle={data ? `${data.round.type} · ${data.round.maxMarks} marks` : "Loading round…"}
    >
      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError ? (
        <p className="text-sm text-destructive">
          {q.error instanceof Error ? q.error.message : "Could not load this round."}
        </p>
      ) : !data ? null : !canPlay ? (
        <div className="surface rounded-lg border border-border/70 p-6">
          <Badge variant="secondary">{myStatus ?? data.status}</Badge>
          <p className="mt-3 text-sm text-muted-foreground">
            {roundState === "PAUSED"
              ? "This round is paused by the organisers. Stay on this page — your clock is frozen."
              : roundState === "ENDED"
                ? "This round has ended."
                : (data.gate.reason ?? "This round is not open yet.")}
          </p>
          <p className="mono-label mt-4 text-muted-foreground">Round state · {roundState}</p>
        </div>
      ) : (
        <>
          <div className="surface mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 px-5 py-3">
            <span className="mono-label text-muted-foreground">Time remaining</span>
            <span className="font-mono text-lg font-bold">{formatTime(remaining)}</span>
            {proctor.count > 0 ? (
              <Badge variant="secondary">{proctor.count} integrity warning(s)</Badge>
            ) : null}
            {!sync.fullscreen ? (
              <Button
                size="sm"
                variant={sync.needsFullscreen ? "destructive" : "outline"}
                onClick={proctor.requestFullscreen}
              >
                {sync.needsFullscreen ? "Fullscreen required" : "Enter fullscreen"}
              </Button>
            ) : null}
          </div>

          <FloatingTimer
            serverSeconds={remaining}
            state={roundState}
            label="Time left"
            paused={paused}
            onExpire={() => void q.refetch()}
          />


          {data.questions.map((question, index) => (
            <div key={question.id} className="surface mb-4 rounded-lg border border-border/70 p-5">
              <p className="text-sm font-medium">
                {index + 1}. {question.prompt}
              </p>
              {question.codeSnippet ? (
                <pre className="mt-3 overflow-x-auto rounded-md bg-muted p-3 text-xs">
                  {question.codeSnippet}
                </pre>
              ) : null}
              {question.type === "MCQ" ? (
                <div className="mt-4 grid gap-2">
                  {question.options.map((option) => (
                    <Button
                      key={option.key}
                      variant={question.selectedOptionKey === option.key ? "default" : "outline"}
                      className="justify-start"
                      disabled={answer.isPending}
                      onClick={() => answer.mutate({ questionId: question.id, optionKey: option.key })}
                    >
                      <span className="mr-2 font-mono">{option.key}</span>
                      {option.text}
                    </Button>
                  ))}
                </div>
              ) : (
                <Textarea
                  className="mt-4 font-mono"
                  defaultValue={question.answerText ?? ""}
                  placeholder="Type the exact program output"
                  onBlur={(event) =>
                    answer.mutate({ questionId: question.id, answerText: event.target.value })
                  }
                />
              )}
            </div>
          ))}

          {data.debugProblems.map((problem) => (
            <Link
              key={problem.id}
              to="/problems/$problemId"
              params={{ problemId: problem.id }}
              search={{ kind: "debug" }}
              className="surface mb-3 flex items-center justify-between rounded-lg border border-border/70 px-5 py-4"
            >
              <div>
                <p className="text-sm font-medium">{problem.title}</p>
                <p className="text-xs text-muted-foreground">
                  {problem.bugsFound} bug(s) fixed · {problem.attempts} attempt(s)
                </p>
              </div>
              <span className="font-mono text-sm">
                {problem.earned} / {problem.marks}
              </span>
            </Link>
          ))}

          {data.codeProblems.map((problem) => (
            <Link
              key={problem.id}
              to="/problems/$problemId"
              params={{ problemId: problem.id }}
              search={{ kind: "code" }}
              className="surface mb-3 flex items-center justify-between rounded-lg border border-border/70 px-5 py-4"
            >
              <div>
                <p className="text-sm font-medium">{problem.title}</p>
                <p className="text-xs text-muted-foreground">
                  {problem.attempts} attempt(s) {problem.solved ? "· solved" : ""}
                </p>
              </div>
              <span className="font-mono text-sm">
                {problem.bestScore} / {problem.marks}
              </span>
            </Link>
          ))}

          <Button
            className="mt-6"
            disabled={finish.isPending}
            onClick={() => finish.mutate()}
          >
            {finish.isPending ? "Submitting…" : "Submit round"}
          </Button>
        </>
      )}
    </AppShell>
  );
}
