import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Row } from "./comp.server";

const answerInput = z.object({
  questionId: z.string().min(1),
  optionKey: z.string().trim().max(8).optional(),
  answerText: z.string().max(4000).optional(),
});

const codeInput = z.object({
  problemId: z.string().min(1),
  language: z.string().trim().min(1).max(20),
  code: z.string().min(1, "Write some code first").max(100_000),
});

/** Round payload for the student. Answer keys and hidden tests never leave the server. */
export const getRoundPlay = createServerFn({ method: "POST" })
  .inputValidator((input: { roundId: string }) => z.object({ roundId: z.string().min(1) }).parse(input))
  .handler(async ({ data }) => {
    const { requireStudent } = await import("./app-session.server");
    const { ownDb } = await import("./own-db.server");
    const { attemptState, getRound, num, str } = await import("./comp.server");
    const claims = await requireStudent();
    const db = ownDb();

    const round = await getRound(data.roundId);
    if (!round) throw new Error("Round not found.");
    const state = await attemptState(claims.studentId, round);
    const type = str(round["type"]);

    const shell = {
      round: {
        id: str(round["id"]),
        name: str(round["name"]),
        type,
        durationMinutes: num(round["durationMinutes"]),
        maxMarks: num(round["maxMarks"]),
        state: state.gate.state,
      },
      gate: state.gate,
      status: state.status,
      canPlay: state.canPlay,
      remainingSeconds: state.remainingSeconds,
      violationLimit: 3,
    };

    // Violation limit is configured per event.
    const { data: settings } = await db.from("event_settings").select("fullscreenViolationLimit").limit(1);
    if (settings?.[0]) shell.violationLimit = num((settings[0] as Row)["fullscreenViolationLimit"], 3);

    if (type === "ROUND1") {
      const { data: questions } = await db
        .from("questions")
        .select("id, type, prompt, codeSnippet, marks, negativeMarks, orderNo")
        .eq("roundId", data.roundId)
        .eq("isEnabled", true)
        .order("orderNo", { ascending: true });
      const ids = (questions ?? []).map((q) => str((q as Row)["id"]));
      const [{ data: options }, { data: mine }] = await Promise.all([
        ids.length
          ? db
              .from("question_options")
              .select("questionId, optionKey, optionText, orderNo")
              .in("questionId", ids)
              .order("orderNo", { ascending: true })
          : Promise.resolve({ data: [] as Row[] }),
        db
          .from("student_answers")
          .select("questionId, selectedOptionKey, answerText")
          .eq("studentId", claims.studentId)
          .eq("roundId", data.roundId),
      ]);
      return {
        ...shell,
        questions: (questions ?? []).map((q) => {
          const row = q as Row;
          const id = str(row["id"]);
          const answer = (mine ?? []).find((a) => str((a as Row)["questionId"]) === id) as Row | undefined;
          return {
            id,
            type: str(row["type"]),
            prompt: str(row["prompt"]),
            codeSnippet: (row["codeSnippet"] as string | null) ?? null,
            marks: num(row["marks"]),
            negativeMarks: num(row["negativeMarks"]),
            options: (options ?? [])
              .filter((o) => str((o as Row)["questionId"]) === id)
              .map((o) => ({
                key: str((o as Row)["optionKey"]),
                text: str((o as Row)["optionText"]),
              })),
            selectedOptionKey: (answer?.["selectedOptionKey"] as string | null) ?? null,
            answerText: (answer?.["answerText"] as string | null) ?? null,
          };
        }),
        debugProblems: [],
        codeProblems: [],
      };
    }

    if (type === "ROUND2") {
      const { data: problems } = await db
        .from("debugging_problems")
        .select("id, title, marks, orderNo")
        .eq("roundId", data.roundId)
        .eq("isEnabled", true)
        .order("orderNo", { ascending: true });
      const ids = (problems ?? []).map((p) => str((p as Row)["id"]));
      const [{ data: awards }, { data: subs }] = await Promise.all([
        ids.length
          ? db
              .from("bug_awards")
              .select("problemId, marksAwarded")
              .eq("studentId", claims.studentId)
              .in("problemId", ids)
          : Promise.resolve({ data: [] as Row[] }),
        ids.length
          ? db
              .from("debugging_submissions")
              .select("problemId")
              .eq("studentId", claims.studentId)
              .in("problemId", ids)
          : Promise.resolve({ data: [] as Row[] }),
      ]);
      return {
        ...shell,
        questions: [],
        debugProblems: (problems ?? []).map((p) => {
          const id = str((p as Row)["id"]);
          const mine = (awards ?? []).filter((a) => str((a as Row)["problemId"]) === id);
          return {
            id,
            title: str((p as Row)["title"]),
            marks: num((p as Row)["marks"]),
            earned: mine.reduce((s, a) => s + num((a as Row)["marksAwarded"]), 0),
            bugsFound: mine.length,
            attempts: (subs ?? []).filter((s) => str((s as Row)["problemId"]) === id).length,
          };
        }),
        codeProblems: [],
      };
    }

    const { data: problems } = await db
      .from("programming_problems")
      .select("id, title, marks, orderNo, timeLimitSec, memoryLimitMb")
      .eq("roundId", data.roundId)
      .eq("isEnabled", true)
      .order("orderNo", { ascending: true });
    const ids = (problems ?? []).map((p) => str((p as Row)["id"]));
    const { data: subs } = ids.length
      ? await db
          .from("programming_submissions")
          .select("problemId, score, status, passedTests, totalTests")
          .eq("studentId", claims.studentId)
          .in("problemId", ids)
      : { data: [] as Row[] };
    return {
      ...shell,
      questions: [],
      debugProblems: [],
      codeProblems: (problems ?? []).map((p) => {
        const id = str((p as Row)["id"]);
        const mine = (subs ?? []).filter((s) => str((s as Row)["problemId"]) === id);
        return {
          id,
          title: str((p as Row)["title"]),
          marks: num((p as Row)["marks"]),
          bestScore: mine.reduce((m, s) => Math.max(m, num((s as Row)["score"])), 0),
          attempts: mine.length,
          solved: mine.some((s) => str((s as Row)["status"]) === "ACCEPTED"),
        };
      }),
    };
  });

/** Grades and stores one Round 1 answer. Grading only ever happens here. */
export const saveAnswer = createServerFn({ method: "POST" })
  .inputValidator((input: z.infer<typeof answerInput>) => answerInput.parse(input))
  .handler(async ({ data }) => {
    const { requireStudent } = await import("./app-session.server");
    const { newId, nowIso, ownDb } = await import("./own-db.server");
    const { getRound, num, requireWritableAttempt, str } = await import("./comp.server");
    const { recalcRoundScore } = await import("./scoring.server");
    const claims = await requireStudent();
    const db = ownDb();

    const { data: question } = await db
      .from("questions")
      .select("*")
      .eq("id", data.questionId)
      .maybeSingle();
    if (!question) throw new Error("Question not found.");
    const q = question as Row;
    if (!q["isEnabled"]) throw new Error("This question is no longer active.");

    const round = await getRound(str(q["roundId"]));
    if (!round) throw new Error("Round not found.");
    await requireWritableAttempt(claims.studentId, round);

    let awarded = 0;
    let selectedOptionKey: string | null = null;
    let answerText: string | null = null;

    if (str(q["type"]) === "MCQ") {
      const key = (data.optionKey ?? "").trim();
      if (!key) throw new Error("Select an option first.");
      const { data: option } = await db
        .from("question_options")
        .select("optionKey")
        .eq("questionId", str(q["id"]))
        .eq("optionKey", key)
        .maybeSingle();
      if (!option) throw new Error("Invalid option selected.");
      selectedOptionKey = key;
      awarded = key === str(q["correctOptionKey"]) ? num(q["marks"]) : -num(q["negativeMarks"]);
    } else {
      const text = data.answerText ?? "";
      answerText = text.slice(0, 4000);
      const method = str(q["comparisonMethod"], "TRIMMED_OUTPUT");
      const expected = str(q["expectedOutput"]);
      const normalise = (v: string) =>
        method === "EXACT_MATCH" ? v.replace(/\r\n/g, "\n") : v.replace(/\r\n/g, "\n").trim();
      const correct = normalise(answerText) === normalise(expected);
      awarded = correct ? num(q["marks"]) : -num(q["negativeMarks"]);
    }

    const now = nowIso();
    const { error } = await db.from("student_answers").upsert(
      {
        id: newId(),
        studentId: claims.studentId,
        roundId: str(q["roundId"]),
        questionId: str(q["id"]),
        selectedOptionKey,
        answerText,
        isFinal: false,
        awardedMarks: awarded,
        createdAt: now,
        updatedAt: now,
      },
      { onConflict: "studentId,questionId" },
    );
    if (error) {
      console.error("[answer] upsert failed", error.message);
      throw new Error("Could not save your answer. Please try again.");
    }

    await recalcRoundScore(claims.studentId, round);
    return { ok: true as const, saved: true };
  });

/** Final submit for a round: locks the attempt and recomputes the score. */
export const submitRound = createServerFn({ method: "POST" })
  .inputValidator((input: { roundId: string }) => z.object({ roundId: z.string().min(1) }).parse(input))
  .handler(async ({ data }) => {
    const { requireStudent } = await import("./app-session.server");
    const { nowIso, ownDb, audit } = await import("./own-db.server");
    const { getRound, str } = await import("./comp.server");
    const { recalcRoundScore } = await import("./scoring.server");
    const claims = await requireStudent();
    const db = ownDb();

    const round = await getRound(data.roundId);
    if (!round) throw new Error("Round not found.");

    const { data: progressRow } = await db
      .from("round_progress")
      .select("*")
      .eq("studentId", claims.studentId)
      .eq("roundId", data.roundId)
      .maybeSingle();
    const progress = (progressRow as Row | null) ?? null;
    const alreadyFinal =
      progress && (str(progress["status"]) === "SUBMITTED" || str(progress["status"]) === "LOCKED");

    // Round 2: evaluate whatever the student last had in the editor before locking.
    if (!alreadyFinal && str(round["type"]) === "ROUND2") {
      const { finalizeRound2 } = await import("./bughunt.server");
      await finalizeRound2(claims.studentId, round, progress);
    }

    const now = nowIso();
    await db
      .from("student_answers")
      .update({ isFinal: true, updatedAt: now })
      .eq("studentId", claims.studentId)
      .eq("roundId", data.roundId);
    const { error } = await db
      .from("round_progress")
      .update({ status: "SUBMITTED", submittedAt: now, updatedAt: now })
      .eq("studentId", claims.studentId)
      .eq("roundId", data.roundId);
    if (error) {
      console.error("[round] submit failed", error.message);
      throw new Error("Could not submit this round. Please try again.");
    }

    const score = await recalcRoundScore(claims.studentId, round);
    if (!alreadyFinal) {
      await audit({
        actorUserId: claims.sub,
        action: "round.submitted",
        entityType: "rounds",
        entityId: data.roundId,
        metadata: { score, roundType: str(round["type"]) },
      });
    }
    return { ok: true as const, score, alreadySubmitted: Boolean(alreadyFinal) };
  });

/** Bug Hunt problem detail. Bug fix patterns and solutions never leave the server. */
export const getDebugProblem = createServerFn({ method: "POST" })
  .inputValidator((input: { problemId: string }) =>
    z.object({ problemId: z.string().min(1) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireStudent } = await import("./app-session.server");
    const { ownDb } = await import("./own-db.server");
    const { attemptState, getRound, num, str } = await import("./comp.server");
    const { readDrafts } = await import("./bughunt.server");
    const claims = await requireStudent();
    const db = ownDb();

    const { data: found } = await db
      .from("debugging_problems")
      .select("*")
      .eq("id", data.problemId)
      .maybeSingle();
    if (!found || !(found as Row)["isEnabled"]) throw new Error("Problem not found.");
    const problem = found as Row;

    const round = await getRound(str(problem["roundId"]));
    if (!round) throw new Error("Round not found.");
    const state = await attemptState(claims.studentId, round);
    if (!state.gate.open && state.status === "NOT_STARTED")
      throw new Error(state.gate.reason || "This round is not open yet.");

    const [{ data: bugs }, { data: awards }, { data: subs }] = await Promise.all([
      db
        .from("bug_definitions")
        .select("id, bugCode, title, description, marks, orderNo, isActive")
        .eq("problemId", data.problemId)
        .order("orderNo", { ascending: true }),
      db
        .from("bug_awards")
        .select("bugDefinitionId, marksAwarded, createdAt")
        .eq("studentId", claims.studentId)
        .eq("problemId", data.problemId),
      db
        .from("debugging_submissions")
        .select("id, score, message, createdAt")
        .eq("studentId", claims.studentId)
        .eq("problemId", data.problemId)
        .order("createdAt", { ascending: false })
        .limit(20),
    ]);

    const awardedIds = new Set((awards ?? []).map((a) => str((a as Row)["bugDefinitionId"])));
    const activeBugs = (bugs ?? []).filter((b) => (b as Row)["isActive"] !== false);
    const drafts = readDrafts(state.progress);
    const lastSubmitted = (subs ?? [])[0] as Row | undefined;
    let savedCode = drafts[data.problemId] ?? "";
    if (!savedCode && lastSubmitted) {
      const { data: latest } = await db
        .from("debugging_submissions")
        .select("sourceCode")
        .eq("id", str(lastSubmitted["id"]))
        .maybeSingle();
      savedCode = str((latest as Row | null)?.["sourceCode"] ?? "");
    }
    if (!savedCode) savedCode = str(problem["starterCode"]) || str(problem["buggyCode"]);

    return {
      problem: {
        id: str(problem["id"]),
        roundId: str(problem["roundId"]),
        title: str(problem["title"]),
        description: str(problem["description"]),
        buggyCode: str(problem["buggyCode"]),
        marks: num(problem["marks"]),
      },
      round: {
        id: str(round["id"]),
        name: str(round["name"]),
        type: str(round["type"]),
        state: state.gate.state,
      },
      gate: state.gate,
      canPlay: state.canPlay,
      status: state.status,
      remainingSeconds: state.remainingSeconds,
      // Only safe, student-facing bug information — never patterns or solutions.
      bugs: activeBugs.map((b) => ({
        id: str((b as Row)["id"]),
        bugCode: str((b as Row)["bugCode"]),
        title: str((b as Row)["title"]),
        description: str((b as Row)["description"]),
        marks: num((b as Row)["marks"]),
        awarded: awardedIds.has(str((b as Row)["id"])),
      })),
      totalBugs: activeBugs.length,
      fixedBugs: activeBugs.filter((b) => awardedIds.has(str((b as Row)["id"]))).length,
      earned: (awards ?? []).reduce((s, a) => s + num((a as Row)["marksAwarded"]), 0),
      savedCode,
      submissions: (subs ?? []).map((s) => ({
        id: str((s as Row)["id"]),
        score: num((s as Row)["score"]),
        message: str((s as Row)["message"]),
        createdAt: str((s as Row)["createdAt"]),
      })),
    };
  });

/** Autosaves the student's working code so it survives navigation and refresh. */
export const saveDebugDraft = createServerFn({ method: "POST" })
  .inputValidator((input: { problemId: string; sourceCode: string }) =>
    z.object({ problemId: z.string().min(1), sourceCode: z.string().max(100_000) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireStudent } = await import("./app-session.server");
    const { ownDb } = await import("./own-db.server");
    const { getRound, requireWritableAttempt, str } = await import("./comp.server");
    const { saveDraft } = await import("./bughunt.server");
    const claims = await requireStudent();

    const { data: found } = await ownDb()
      .from("debugging_problems")
      .select("id, roundId, isEnabled")
      .eq("id", data.problemId)
      .maybeSingle();
    if (!found || !(found as Row)["isEnabled"]) throw new Error("Problem not found.");
    const round = await getRound(str((found as Row)["roundId"]));
    if (!round) throw new Error("Round not found.");
    const state = await requireWritableAttempt(claims.studentId, round);
    if (!state.progress) throw new Error("Your attempt for this round is not active.");
    await saveDraft(state.progress, data.problemId, data.sourceCode);
    return { ok: true as const };
  });

/** Runs the student's current code in the local sandbox. Never awards marks. */
export const runDebugCode = createServerFn({ method: "POST" })
  .inputValidator((input: { problemId: string; sourceCode: string }) =>
    z.object({ problemId: z.string().min(1), sourceCode: z.string().min(1).max(100_000) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireStudent } = await import("./app-session.server");
    const { ownDb } = await import("./own-db.server");
    const { getRound, requireWritableAttempt, str } = await import("./comp.server");
    const { checkDebugCode } = await import("./bughunt.server");
    const claims = await requireStudent();
    const { enforceRateLimit } = await import("./rate-limit.server");
    enforceRateLimit("run", claims.studentId);

    const { data: found } = await ownDb()
      .from("debugging_problems")
      .select("*")
      .eq("id", data.problemId)
      .maybeSingle();
    if (!found || !(found as Row)["isEnabled"]) throw new Error("Problem not found.");
    const problem = found as Row;
    const round = await getRound(str(problem["roundId"]));
    if (!round) throw new Error("Round not found.");
    await requireWritableAttempt(claims.studentId, round);

    const result = await checkDebugCode(problem, data.sourceCode);
    return {
      status: result.status,
      compiled: result.compiled,
      output: result.output,
      error: result.error,
      durationMs: result.durationMs,
    };
  });

/**
 * Evaluates a Bug Hunt submission against the administrator's configured bug
 * patterns. Marks for a bug are awarded at most once per student and problem.
 */
export const submitDebugFix = createServerFn({ method: "POST" })
  .inputValidator((input: { problemId: string; sourceCode: string }) =>
    z.object({ problemId: z.string().min(1), sourceCode: z.string().min(1).max(100_000) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireStudent } = await import("./app-session.server");
    const { ownDb } = await import("./own-db.server");
    const { getRound, requireWritableAttempt, str } = await import("./comp.server");
    const { evaluateDebugSubmission, saveDraft } = await import("./bughunt.server");
    const { recalcRoundScore } = await import("./scoring.server");
    const claims = await requireStudent();
    const { enforceRateLimit } = await import("./rate-limit.server");
    enforceRateLimit("submit", claims.studentId);

    const { data: found } = await ownDb()
      .from("debugging_problems")
      .select("*")
      .eq("id", data.problemId)
      .maybeSingle();
    if (!found || !(found as Row)["isEnabled"]) throw new Error("Problem not found.");
    const problem = found as Row;

    const round = await getRound(str(problem["roundId"]));
    if (!round) throw new Error("Round not found.");
    const state = await requireWritableAttempt(claims.studentId, round);

    const evaluation = await evaluateDebugSubmission({
      studentId: claims.studentId,
      problem,
      sourceCode: data.sourceCode,
    });
    if (state.progress) await saveDraft(state.progress, data.problemId, data.sourceCode);
    const roundScore = await recalcRoundScore(claims.studentId, round);

    // Safe feedback only: no bug identifiers, patterns or solution details.
    return {
      ok: true as const,
      compiled: evaluation.compiled,
      executionOk: evaluation.executionOk,
      message: evaluation.message,
      roundScore,
    };
  });


/** Code Sprint problem detail. Hidden test cases are never returned. */
export const getCodeProblem = createServerFn({ method: "POST" })
  .inputValidator((input: { problemId: string }) =>
    z.object({ problemId: z.string().min(1) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { requireStudent } = await import("./app-session.server");
    const { ownDb } = await import("./own-db.server");
    const { attemptState, getRound, num, str } = await import("./comp.server");
    const { EXECUTABLE_LANGUAGES } = await import("./judge.server");
    const claims = await requireStudent();
    const db = ownDb();

    const { data: found } = await db
      .from("programming_problems")
      .select("*")
      .eq("id", data.problemId)
      .maybeSingle();
    if (!found || !(found as Row)["isEnabled"]) throw new Error("Problem not found.");
    const problem = found as Row;

    const round = await getRound(str(problem["roundId"]));
    if (!round) throw new Error("Round not found.");
    const state = await attemptState(claims.studentId, round);

    const [{ data: visible }, { count: hiddenCount }, { data: subs }] = await Promise.all([
      db
        .from("test_cases")
        .select("id, input, expectedOutput, orderNo")
        .eq("problemId", data.problemId)
        .eq("isHidden", false)
        .order("orderNo", { ascending: true }),
      db
        .from("test_cases")
        .select("id", { count: "exact", head: true })
        .eq("problemId", data.problemId)
        .eq("isHidden", true),
      db
        .from("programming_submissions")
        .select("id, language, status, score, passedTests, totalTests, executionMs, createdAt")
        .eq("studentId", claims.studentId)
        .eq("problemId", data.problemId)
        .order("createdAt", { ascending: false })
        .limit(20),
    ]);

    return {
      problem: {
        id: str(problem["id"]),
        roundId: str(problem["roundId"]),
        title: str(problem["title"]),
        description: str(problem["description"]),
        inputFormat: str(problem["inputFormat"]),
        outputFormat: str(problem["outputFormat"]),
        constraints: str(problem["constraints"]),
        examples: str(problem["examples"]),
        starterCode: str(problem["starterCode"]),
        marks: num(problem["marks"]),
        timeLimitSec: num(problem["timeLimitSec"], 2),
        memoryLimitMb: num(problem["memoryLimitMb"], 128),
      },
      round: {
        id: str(round["id"]),
        name: str(round["name"]),
        type: str(round["type"]),
        state: state.gate.state,
      },
      gate: state.gate,
      canPlay: state.canPlay,
      status: state.status,
      remainingSeconds: state.remainingSeconds,
      languages: [...EXECUTABLE_LANGUAGES],
      visibleTests: (visible ?? []).map((t) => ({
        input: str((t as Row)["input"]),
        expectedOutput: str((t as Row)["expectedOutput"]),
      })),
      hiddenTestCount: hiddenCount ?? 0,
      submissions: (subs ?? []).map((s) => ({
        id: str((s as Row)["id"]),
        language: str((s as Row)["language"]),
        status: str((s as Row)["status"]),
        score: num((s as Row)["score"]),
        passedTests: num((s as Row)["passedTests"]),
        totalTests: num((s as Row)["totalTests"]),
        executionMs: num((s as Row)["executionMs"]),
        createdAt: str((s as Row)["createdAt"]),
      })),
    };
  });

/** Trial run against visible test cases only. Nothing is stored or scored. */
export const runCode = createServerFn({ method: "POST" })
  .inputValidator((input: z.infer<typeof codeInput>) => codeInput.parse(input))
  .handler(async ({ data }) => {
    const { requireStudent } = await import("./app-session.server");
    const { ownDb } = await import("./own-db.server");
    const { judgeSubmission } = await import("./judge.server");
    await requireStudent();
    const { enforceRateLimit } = await import("./rate-limit.server");
    enforceRateLimit("run");
    const db = ownDb();

    const { data: problem } = await db
      .from("programming_problems")
      .select("*")
      .eq("id", data.problemId)
      .maybeSingle();
    if (!problem) throw new Error("Problem not found.");

    const { data: tests } = await db
      .from("test_cases")
      .select("*")
      .eq("problemId", data.problemId)
      .eq("isHidden", false)
      .order("orderNo", { ascending: true });

    const result = await judgeSubmission(data.language, data.code, (tests ?? []) as Row[], problem as Row);
    return {
      status: result.status,
      message: result.message,
      passed: result.passed,
      total: result.total,
      results: result.results,
    };
  });

/** Full judged submission: every test case runs, the score is stored server-side. */
export const submitCode = createServerFn({ method: "POST" })
  .inputValidator((input: z.infer<typeof codeInput>) => codeInput.parse(input))
  .handler(async ({ data }) => {
    const { requireStudent } = await import("./app-session.server");
    const { newId, nowIso, ownDb } = await import("./own-db.server");
    const { getRound, requireWritableAttempt, str } = await import("./comp.server");
    const { judgeSubmission, redactForStudent } = await import("./judge.server");
    const { recalcRoundScore } = await import("./scoring.server");
    const claims = await requireStudent();
    const { enforceRateLimit } = await import("./rate-limit.server");
    enforceRateLimit("submit", claims.studentId);
    const db = ownDb();

    const { data: found } = await db
      .from("programming_problems")
      .select("*")
      .eq("id", data.problemId)
      .maybeSingle();
    if (!found || !(found as Row)["isEnabled"]) throw new Error("Problem not found.");
    const problem = found as Row;

    const round = await getRound(str(problem["roundId"]));
    if (!round) throw new Error("Round not found.");
    await requireWritableAttempt(claims.studentId, round);

    const now = nowIso();
    const submissionId = newId();
    const { error: insertError } = await db.from("programming_submissions").insert({
      id: submissionId,
      studentId: claims.studentId,
      problemId: data.problemId,
      sourceCode: data.code,
      language: data.language,
      status: "RUNNING",
      score: 0,
      isFinal: false,
      submittedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    if (insertError) {
      console.error("[submit] insert failed", insertError.message);
      throw new Error("Could not record your submission. Please try again.");
    }

    const { data: tests } = await db
      .from("test_cases")
      .select("*")
      .eq("problemId", data.problemId)
      .order("orderNo", { ascending: true });

    const result = await judgeSubmission(data.language, data.code, (tests ?? []) as Row[], problem);

    const { error: updateError } = await db
      .from("programming_submissions")
      .update({
        status: result.status,
        score: result.score,
        passedTests: result.passed,
        totalTests: result.total,
        executionMs: result.durationMs,
        resultJson: {
          message: result.message,
          passed: result.passed,
          failed: result.failed,
          total: result.total,
          durationMs: result.durationMs,
          memoryLimitMb: problem["memoryLimitMb"] ?? null,
          tests: result.results.map((r) => ({ index: r.index, hidden: r.hidden, passed: r.passed })),
        },
        updatedAt: nowIso(),
      })
      .eq("id", submissionId);
    if (updateError) console.error("[submit] update failed", updateError.message);

    const roundScore = await recalcRoundScore(claims.studentId, round);

    return {
      submissionId,
      status: result.status,
      score: result.score,
      passed: result.passed,
      failed: result.failed,
      total: result.total,
      durationMs: result.durationMs,
      message: result.message,
      results: redactForStudent(result.results),
      roundScore,
    };
  });

/** Records an anti-cheating violation for the current round. */
export const reportViolation = createServerFn({ method: "POST" })
  .inputValidator((input: { roundId: string; type: string; details?: string }) =>
    z
      .object({
        roundId: z.string().min(1),
        type: z.enum(["FULLSCREEN_EXIT", "TAB_HIDDEN", "WINDOW_BLUR", "MULTIPLE_SESSION", "COPY_PASTE"]),
        details: z.string().max(500).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { requireStudent } = await import("./app-session.server");
    const { newId, nowIso, ownDb } = await import("./own-db.server");
    const { num } = await import("./comp.server");
    const claims = await requireStudent();
    const { enforceRateLimit } = await import("./rate-limit.server");
    enforceRateLimit("violation", claims.studentId);
    const db = ownDb();

    await db.from("violations").insert({
      id: newId(),
      studentId: claims.studentId,
      roundId: data.roundId,
      type: data.type,
      count: 1,
      details: data.details ?? "",
      createdAt: nowIso(),
    });

    const [{ count }, { data: settings }] = await Promise.all([
      db
        .from("violations")
        .select("id", { count: "exact", head: true })
        .eq("studentId", claims.studentId)
        .eq("roundId", data.roundId),
      db.from("event_settings").select("fullscreenViolationLimit").limit(1),
    ]);
    const limit = num((settings?.[0] as Row | undefined)?.["fullscreenViolationLimit"], 3);
    const total = count ?? 0;

    if (total >= limit) {
      const now = nowIso();
      await db
        .from("round_progress")
        .update({ status: "LOCKED", lockedAt: now, updatedAt: now })
        .eq("studentId", claims.studentId)
        .eq("roundId", data.roundId)
        .eq("status", "IN_PROGRESS");
    }
    return { total, limit, locked: total >= limit };
  });

/** Round-by-round results for the signed-in student. */
export const getMyResults = createServerFn({ method: "GET" }).handler(async () => {
  const { requireStudent } = await import("./app-session.server");
  const { ownDb } = await import("./own-db.server");
  const { num, str } = await import("./comp.server");
  const claims = await requireStudent();
  const db = ownDb();

  const [{ data: rounds }, { data: scores }, { data: final }, { data: visibility }, { count: participants }] =
    await Promise.all([
      db.from("rounds").select("id, name, type, orderNo, maxMarks, state").order("orderNo"),
      db.from("round_scores").select("roundId, score, maxMarks, evaluatedAt").eq("studentId", claims.studentId),
      db
        .from("final_scores")
        .select("totalScore, maxScore, rank")
        .eq("studentId", claims.studentId)
        .maybeSingle(),
      db.from("visibility_settings").select("showResults, showAnswers").limit(1),
      db.from("students").select("id", { count: "exact", head: true }),
    ]);

  const published = Boolean((visibility?.[0] as Row | undefined)?.["showResults"]);
  return {
    published,
    participants: participants ?? 0,
    total: num((final as Row | null)?.["totalScore"]),
    max: num(
      (final as Row | null)?.["maxScore"] ??
        (rounds ?? []).reduce((s, r) => s + num((r as Row)["maxMarks"]), 0),
    ),
    rank: published ? (((final as Row | null)?.["rank"] as number | null) ?? null) : null,
    rounds: (rounds ?? []).map((r) => {
      const row = r as Row;
      const mine = (scores ?? []).find((s) => str((s as Row)["roundId"]) === str(row["id"])) as
        | Row
        | undefined;
      return {
        id: str(row["id"]),
        name: str(row["name"]),
        type: str(row["type"]),
        maxMarks: num(row["maxMarks"]),
        score: mine ? num(mine["score"]) : null,
        evaluatedAt: (mine?.["evaluatedAt"] as string | null) ?? null,
      };
    }),
  };
});

/** Complete submission history (Bug Hunt + Code Sprint) for the student. */
export const getMySubmissions = createServerFn({ method: "GET" }).handler(async () => {
  const { requireStudent } = await import("./app-session.server");
  const { ownDb } = await import("./own-db.server");
  const { num, str } = await import("./comp.server");
  const claims = await requireStudent();
  const db = ownDb();

  const [{ data: prog }, { data: debug }, { data: progProblems }, { data: debugProblems }] =
    await Promise.all([
      db
        .from("programming_submissions")
        .select("id, problemId, language, status, score, passedTests, totalTests, executionMs, createdAt")
        .eq("studentId", claims.studentId)
        .order("createdAt", { ascending: false })
        .limit(100),
      db
        .from("debugging_submissions")
        .select("id, problemId, score, message, createdAt")
        .eq("studentId", claims.studentId)
        .order("createdAt", { ascending: false })
        .limit(100),
      db.from("programming_problems").select("id, title"),
      db.from("debugging_problems").select("id, title"),
    ]);

  const titleOf = (rows: Row[] | null | undefined, id: string) =>
    str((rows ?? []).find((r) => str(r["id"]) === id)?.["title"], "Problem");

  return {
    code: (prog ?? []).map((s) => {
      const row = s as Row;
      return {
        id: str(row["id"]),
        title: titleOf(progProblems as Row[], str(row["problemId"])),
        language: str(row["language"]),
        status: str(row["status"]),
        score: num(row["score"]),
        passedTests: num(row["passedTests"]),
        totalTests: num(row["totalTests"]),
        executionMs: num(row["executionMs"]),
        createdAt: str(row["createdAt"]),
      };
    }),
    debug: (debug ?? []).map((s) => {
      const row = s as Row;
      return {
        id: str(row["id"]),
        title: titleOf(debugProblems as Row[], str(row["problemId"])),
        score: num(row["score"]),
        message: str(row["message"]),
        createdAt: str(row["createdAt"]),
      };
    }),
  };
});

/** Profile card data for the signed-in student. */
export const getMyProfile = createServerFn({ method: "GET" }).handler(async () => {
  const { requireStudent } = await import("./app-session.server");
  const { ownDb } = await import("./own-db.server");
  const { num, str } = await import("./comp.server");
  const claims = await requireStudent();
  const db = ownDb();

  const { data: student } = await db
    .from("students")
    .select("id, fullName, status, batchId, createdAt")
    .eq("id", claims.studentId)
    .maybeSingle();
  const row = (student as Row | null) ?? {};
  const [{ data: user }, { data: batch }, { count: sessions }] = await Promise.all([
    db.from("users").select("studentId, username").eq("id", claims.sub).maybeSingle(),
    row["batchId"]
      ? db.from("batches").select("code, name").eq("id", str(row["batchId"])).maybeSingle()
      : Promise.resolve({ data: null }),
    db
      .from("sessions")
      .select("id", { count: "exact", head: true })
      .eq("studentId", claims.studentId)
      .eq("isRevoked", false),
  ]);

  return {
    fullName: str(row["fullName"], "Student"),
    studentCode: str((user as Row | null)?.["studentId"], "—"),
    batchNumber: str((batch as Row | null)?.["code"], "—"),
    status: str(row["status"], "ACTIVE"),
    joinedAt: str(row["createdAt"]),
    activeSessions: num(sessions),
  };
});
