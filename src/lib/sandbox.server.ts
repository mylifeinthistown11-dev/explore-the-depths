/**
 * Server-side sandboxed code execution.
 *
 * Student code never touches the host runtime: it is compiled and executed
 * inside an isolated QuickJS WebAssembly virtual machine with its own heap,
 * a hard memory limit, a wall-clock interrupt handler and NO access to the
 * network, filesystem, timers or any host object. Only two host bridges are
 * exposed (`readLine` for stdin, `print` for stdout).
 */
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSWASMModule } from "quickjs-emscripten-core";
import singlefileVariant from "@jitl/quickjs-singlefile-browser-release-sync";
import wasmfileVariant from "@jitl/quickjs-wasmfile-release-sync";

export type ExecOutcome = "ok" | "runtime_error" | "compilation_error" | "timeout" | "memory";

export interface ExecResult {
  outcome: ExecOutcome;
  stdout: string;
  error: string;
  durationMs: number;
}

/**
 * Edge runtimes (Cloudflare workerd) forbid compiling WebAssembly from bytes at
 * runtime — the single-file variant would abort with
 * "Wasm code generation disallowed by embedder". There, the .wasm asset is
 * imported as an already-compiled WebAssembly.Module. Node keeps the
 * single-file variant, which needs no asset resolution.
 */
async function resolveVariant() {
  try {
    const imported = (await import(
      /* @vite-ignore */ "@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm"
    )) as { default?: unknown };
    const compiled = imported.default;
    if (typeof WebAssembly !== "undefined" && compiled instanceof WebAssembly.Module) {
      return newVariant(wasmfileVariant as never, { wasmModule: compiled } as never);
    }
  } catch {
    // Asset import is unavailable in this runtime; use the embedded build.
  }
  return singlefileVariant as never;
}

let modulePromise: Promise<QuickJSWASMModule> | null = null;
function getModule(): Promise<QuickJSWASMModule> {
  if (!modulePromise) {
    modulePromise = resolveVariant()
      .then((variant) => newQuickJSWASMModuleFromVariant(variant as never))
      .catch((error) => {
        modulePromise = null;
        throw error;
      });
  }
  return modulePromise;
}


const PRELUDE = `
globalThis.__out = [];
globalThis.console = {
  log: (...a) => print(...a),
  error: (...a) => print(...a),
  warn: (...a) => print(...a),
  info: (...a) => print(...a),
};
globalThis.readInt = () => parseInt(readLine(), 10);
globalThis.readInts = () => readLine().trim().split(/\\s+/).filter(Boolean).map(Number);
`;

export async function runJavaScript(
  code: string,
  stdin: string,
  timeLimitMs: number,
  memoryLimitMb: number,
): Promise<ExecResult> {
  const started = Date.now();
  const QuickJS = await getModule();
  const runtime = QuickJS.newRuntime();
  const lines = stdin.replace(/\r\n/g, "\n").split("\n");
  let cursor = 0;
  const out: string[] = [];

  try {
    runtime.setMemoryLimit(Math.max(8, memoryLimitMb) * 1024 * 1024);
    runtime.setMaxStackSize(1024 * 512);
    const deadline = started + Math.min(Math.max(timeLimitMs, 100), 10_000);
    runtime.setInterruptHandler(() => Date.now() > deadline);

    const vm = runtime.newContext();
    try {
      const printFn = vm.newFunction("print", (...args) => {
        out.push(args.map((a) => String(vm.dump(a))).join(" "));
      });
      vm.setProp(vm.global, "print", printFn);
      printFn.dispose();

      const readLineFn = vm.newFunction("readLine", () =>
        vm.newString(cursor < lines.length ? (lines[cursor++] ?? "") : ""),
      );
      vm.setProp(vm.global, "readLine", readLineFn);
      readLineFn.dispose();

      const readAllFn = vm.newFunction("readAll", () => vm.newString(stdin));
      vm.setProp(vm.global, "readAll", readAllFn);
      readAllFn.dispose();

      const prelude = vm.evalCode(PRELUDE);
      if (prelude.error) prelude.error.dispose();
      else prelude.value.dispose();

      const result = vm.evalCode(code, "solution.js");
      if (result.error) {
        const dumped = vm.dump(result.error);
        result.error.dispose();
        const message =
          typeof dumped === "object" && dumped !== null
            ? `${(dumped as { name?: string }).name ?? "Error"}: ${(dumped as { message?: string }).message ?? ""}`
            : String(dumped);
        const elapsed = Date.now() - started;
        if (elapsed >= timeLimitMs || /interrupted/i.test(message)) {
          return { outcome: "timeout", stdout: out.join("\n"), error: "Execution timed out", durationMs: elapsed };
        }
        if (/out of memory/i.test(message)) {
          return { outcome: "memory", stdout: out.join("\n"), error: "Memory limit exceeded", durationMs: elapsed };
        }
        if (/SyntaxError/i.test(message)) {
          return { outcome: "compilation_error", stdout: "", error: message, durationMs: elapsed };
        }
        return { outcome: "runtime_error", stdout: out.join("\n"), error: message, durationMs: elapsed };
      }
      result.value.dispose();
      return { outcome: "ok", stdout: out.join("\n"), error: "", durationMs: Date.now() - started };
    } finally {
      vm.dispose();
    }
  } catch (err) {
    return {
      outcome: "runtime_error",
      stdout: out.join("\n"),
      error: err instanceof Error ? err.message : "Sandbox failure",
      durationMs: Date.now() - started,
    };
  } finally {
    runtime.dispose();
  }
}

export function normalizeOutput(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n+$/, "")
    .trim();
}
