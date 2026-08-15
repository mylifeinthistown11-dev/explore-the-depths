/**
 * In-platform test-case evaluation. Student code runs inside the QuickJS WASM
 * sandbox on the server (no external judge service, no API key). The backend is
 * the only authority for pass counts and scores.
 */
import { normalizeOutput, runJavaScript } from "./sandbox.server";
import { num, str, type Row } from "./comp.server";

export const EXECUTABLE_LANGUAGES = ["JAVASCRIPT"] as const;
export type Language = "JAVASCRIPT" | "C" | "CPP" | "JAVA" | "PYTHON";

export type SubmissionStatus =
  | "ACCEPTED"
  | "WRONG_ANSWER"
  | "COMPILE_ERROR"
  | "RUNTIME_ERROR"
  | "TIME_LIMIT"
  | "INTERNAL_ERROR";

export type TestOutcome = {
  index: number;
  hidden: boolean;
  passed: boolean;
  durationMs: number;
  input?: string;
  expected?: string;
  actual?: string;
  error?: string;
};

export type JudgeResult = {
  status: SubmissionStatus;
  score: number;
  passed: number;
  failed: number;
  total: number;
  durationMs: number;
  message: string;
  results: TestOutcome[];
};

export function isExecutable(language: string): boolean {
  return (EXECUTABLE_LANGUAGES as readonly string[]).includes(language);
}

export async function judgeSubmission(
  language: string,
  code: string,
  tests: Row[],
  problem: Row,
): Promise<JudgeResult> {
  const total = tests.length;
  const base = { score: 0, passed: 0, failed: total, total, durationMs: 0, results: [] as TestOutcome[] };

  if (!isExecutable(language)) {
    return {
      ...base,
      status: "INTERNAL_ERROR",
      message: `${language} cannot be executed on this server. Submit in JavaScript, which this platform runs natively.`,
    };
  }
  if (total === 0) {
    return { ...base, status: "INTERNAL_ERROR", message: "This problem has no test cases configured yet." };
  }

  const timeLimitMs = Math.max(200, num(problem["timeLimitSec"], 2) * 1000);
  const memoryLimitMb = num(problem["memoryLimitMb"], 128);
  const maxMarks = num(problem["marks"], 0);

  const results: TestOutcome[] = [];
  let passed = 0;
  let passedWeight = 0;
  let totalWeight = 0;
  let durationMs = 0;
  let status: SubmissionStatus = "ACCEPTED";
  let message = "All test cases passed.";

  for (let i = 0; i < tests.length; i++) {
    const test = tests[i] as Row;
    const hidden = Boolean(test["isHidden"]);
    const weight = Math.max(1, num(test["marks"], 1));
    totalWeight += weight;

    const run = await runJavaScript(code, str(test["input"]), timeLimitMs, memoryLimitMb);
    durationMs += run.durationMs;

    if (run.outcome !== "ok") {
      const mapped: SubmissionStatus =
        run.outcome === "timeout"
          ? "TIME_LIMIT"
          : run.outcome === "compilation_error"
            ? "COMPILE_ERROR"
            : "RUNTIME_ERROR";
      if (status === "ACCEPTED") {
        status = mapped;
        message = run.error || "Execution failed.";
      }
      results.push({
        index: i + 1,
        hidden,
        passed: false,
        durationMs: run.durationMs,
        ...(hidden ? {} : { input: str(test["input"]), expected: normalizeOutput(str(test["expectedOutput"])), actual: run.stdout }),
        error: run.error,
      });
      if (run.outcome === "compilation_error") break;
      continue;
    }

    const actual = normalizeOutput(run.stdout);
    const expected = normalizeOutput(str(test["expectedOutput"]));
    const ok = actual === expected;
    if (ok) {
      passed += 1;
      passedWeight += weight;
    } else if (status === "ACCEPTED") {
      status = "WRONG_ANSWER";
      message = `Failed on test case ${i + 1}.`;
    }

    results.push({
      index: i + 1,
      hidden,
      passed: ok,
      durationMs: run.durationMs,
      ...(hidden ? {} : { input: str(test["input"]), expected, actual }),
    });
  }

  if (status === "ACCEPTED" && passed !== total) {
    status = "WRONG_ANSWER";
    message = "Some test cases failed.";
  }

  const score = totalWeight > 0 ? Math.round((passedWeight / totalWeight) * maxMarks) : 0;
  return {
    status,
    score,
    passed,
    failed: total - passed,
    total,
    durationMs,
    message,
    results,
  };
}

/** Hidden cases disclose pass/fail only — never inputs or expected outputs. */
export function redactForStudent(results: TestOutcome[]): TestOutcome[] {
  return results.map((r) =>
    r.hidden ? { index: r.index, hidden: true, passed: r.passed, durationMs: r.durationMs } : r,
  );
}
