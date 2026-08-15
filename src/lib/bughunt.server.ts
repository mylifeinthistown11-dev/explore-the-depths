/**
 * Round 2 — Bug Hunt engine (server only).
 *
 * The backend is the sole authority for bug detection, bug awards and Round 2
 * scores. Nothing here trusts client input: the student only ever supplies the
 * source code, and every award decision is made from the administrator's
 * configured bug definitions stored in the event database.
 */
import { newId, nowIso, ownDb } from "./own-db.server";
import { num, str, type Row } from "./comp.server";
import { normalizeOutput, runJavaScript } from "./sandbox.server";

export type BugFixSummary = { bugCode: string; title: string; marks: number };

export type DebugEvaluation = {
  submissionId: string;
  awardedNow: number;
  newlyFixed: BugFixSummary[];
  compiled: boolean;
  executionOk: boolean;
  message: string;
};

/** Runs student code in the local WASM sandbox — never an external service. */
export async function checkDebugCode(problem: Row, sourceCode: string) {
  const timeLimitMs = Math.max(200, num(problem["timeLimitSec"], 2) * 1000);
  const memoryLimitMb = num(problem["memoryLimitMb"], 128);
  const run = await runJavaScript(sourceCode, "", timeLimitMs, memoryLimitMb);
  const status =
    run.outcome === "ok"
      ? "Execution successful"
      : run.outcome === "compilation_error"
        ? "Compilation error"
        : run.outcome === "timeout"
          ? "Time limit exceeded"
          : run.outcome === "memory"
            ? "Memory limit exceeded"
            : "Runtime error";
  return {
    status,
    compiled: run.outcome !== "compilation_error",
    executionOk: run.outcome === "ok",
    output: normalizeOutput(run.stdout).slice(0, 4000),
    error: run.error.slice(0, 1000),
    durationMs: run.durationMs,
  };
}

/** True when the configured bug is fixed in this source code. */
function isBugFixed(bug: Row, sourceCode: string): boolean {
  const pattern = bug["fixPattern"] ? str(bug["fixPattern"]) : null;
  const forbidden = bug["mustNotMatch"] ? str(bug["mustNotMatch"]) : null;
  if (!pattern && !forbidden) return false; // not configured for automatic evaluation
  try {
    if (pattern && !new RegExp(pattern, "m").test(sourceCode)) return false;
    if (forbidden && new RegExp(forbidden, "m").test(sourceCode)) return false;
    return true;
  } catch (err) {
    console.error("[bughunt] invalid bug pattern", str(bug["id"]), err);
    return false;
  }
}

/**
 * Records a submission and awards every newly fixed bug, at most once per
 * student and bug (guarded by the unique index on bug_awards).
 */
export async function evaluateDebugSubmission(input: {
  studentId: string;
  problem: Row;
  sourceCode: string;
  isFinal?: boolean;
}): Promise<DebugEvaluation> {
  const db = ownDb();
  const problemId = str(input.problem["id"]);
  const now = nowIso();
  const submissionId = newId();

  const execution = await checkDebugCode(input.problem, input.sourceCode);

  const { error: subError } = await db.from("debugging_submissions").insert({
    id: submissionId,
    studentId: input.studentId,
    problemId,
    sourceCode: input.sourceCode,
    isFinal: input.isFinal ?? false,
    submittedAt: now,
    score: 0,
    message: "",
    createdAt: now,
    updatedAt: now,
  });
  if (subError) {
    console.error("[bughunt] submission insert failed", subError.message);
    throw new Error("Could not record your submission. Please try again.");
  }

  const [{ data: bugs }, { data: awards }] = await Promise.all([
    db.from("bug_definitions").select("*").eq("problemId", problemId).order("orderNo"),
    db
      .from("bug_awards")
      .select("bugDefinitionId")
      .eq("studentId", input.studentId)
      .eq("problemId", problemId),
  ]);
  const already = new Set((awards ?? []).map((a) => str((a as Row)["bugDefinitionId"])));

  const newlyFixed: BugFixSummary[] = [];
  let awardedNow = 0;

  if (execution.compiled) {
    for (const raw of bugs ?? []) {
      const bug = raw as Row;
      const bugId = str(bug["id"]);
      if (bug["isActive"] === false) continue;
      if (already.has(bugId)) continue;
      if (!isBugFixed(bug, input.sourceCode)) continue;

      const marks = num(bug["marks"]);
      const { error } = await db.from("bug_awards").insert({
        id: newId(),
        studentId: input.studentId,
        problemId,
        submissionId,
        bugDefinitionId: bugId,
        marksAwarded: marks,
        createdAt: nowIso(),
      });
      // 23505 = a concurrent submission already awarded this bug; never award twice.
      if (error) {
        if (error.code !== "23505") console.error("[bughunt] award insert failed", error.message);
        continue;
      }
      awardedNow += marks;
      newlyFixed.push({ bugCode: str(bug["bugCode"]), title: str(bug["title"]), marks });
    }
  }

  const message = execution.compiled
    ? "Submission recorded."
    : "Submission recorded — your code did not compile.";

  await db
    .from("debugging_submissions")
    .update({ score: awardedNow, message, updatedAt: nowIso() })
    .eq("id", submissionId);

  return {
    submissionId,
    awardedNow,
    newlyFixed,
    compiled: execution.compiled,
    executionOk: execution.executionOk,
    message,
  };
}

/** Draft code the student is currently editing, stored on their progress row. */
export function readDrafts(progress: Row | null): Record<string, string> {
  const saved = (progress?.["savedData"] ?? {}) as Record<string, unknown>;
  const drafts = (saved["debugDrafts"] ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(drafts)) out[key] = String(value ?? "");
  return out;
}

export async function saveDraft(progress: Row, problemId: string, sourceCode: string) {
  const saved = ((progress["savedData"] ?? {}) as Record<string, unknown>) || {};
  const drafts = { ...readDrafts(progress), [problemId]: sourceCode };
  await ownDb()
    .from("round_progress")
    .update({ savedData: { ...saved, debugDrafts: drafts }, updatedAt: nowIso() })
    .eq("id", str(progress["id"]));
}

/**
 * Final evaluation for Round 2: every unevaluated draft is judged once more so
 * the stored score reflects the student's last state. Idempotent — repeated
 * calls cannot produce duplicate awards because awards are unique per bug.
 */
export async function finalizeRound2(studentId: string, round: Row, progress: Row | null) {
  const db = ownDb();
  const { data: problems } = await db
    .from("debugging_problems")
    .select("*")
    .eq("roundId", str(round["id"]))
    .eq("isEnabled", true);
  const drafts = readDrafts(progress);

  for (const raw of problems ?? []) {
    const problem = raw as Row;
    const problemId = str(problem["id"]);
    const draft = drafts[problemId];
    if (!draft || !draft.trim()) continue;

    const { data: last } = await db
      .from("debugging_submissions")
      .select("sourceCode")
      .eq("studentId", studentId)
      .eq("problemId", problemId)
      .order("createdAt", { ascending: false })
      .limit(1);
    const lastCode = str((last?.[0] as Row | undefined)?.["sourceCode"] ?? "");
    if (lastCode === draft) continue; // already evaluated in this exact state

    try {
      await evaluateDebugSubmission({ studentId, problem, sourceCode: draft, isFinal: true });
    } catch (err) {
      console.error("[bughunt] finalize failed", problemId, err);
    }
  }

  await db
    .from("debugging_submissions")
    .update({ isFinal: true, updatedAt: nowIso() })
    .eq("studentId", studentId)
    .in("problemId", (problems ?? []).map((p) => str((p as Row)["id"])));
}
