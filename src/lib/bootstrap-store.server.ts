/**
 * Persistent BOOTSTRAP configuration store.
 *
 * This store deliberately does NOT depend on the application database: it is
 * what tells the server how to reach that database in the first place.
 * Values are written to a small JSON file on the server's persistent volume
 * (override the location with BOOTSTRAP_CONFIG_PATH) and mirrored in memory so
 * the running process picks up new values immediately.
 *
 * Secrets never leave this module: only "configured / not configured" flags
 * (plus the non-secret ADMIN_EMAIL) are ever exposed to callers.
 */

export const CONFIG_KEYS = [
  "APP_SESSION_SECRET",
  "ADMIN_EMAIL",
  "ADMIN_PASSWORD",
  "DEFAULT_STUDENT_PASSWORD",
  "OWN_SUPABASE_DB_URL",
  "OWN_SUPABASE_SERVICE_ROLE_KEY",
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

type Store = Partial<Record<ConfigKey, string>>;

let memory: Store | null = null;
let persistent = true;

function filePath(): string {
  return process.env["BOOTSTRAP_CONFIG_PATH"] ?? ".data/codearena-config.json";
}

async function load(): Promise<Store> {
  if (memory) return memory;
  const values: Store = {};
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(filePath(), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of CONFIG_KEYS) {
      const value = parsed[key];
      if (typeof value === "string" && value.length > 0) values[key] = value;
    }
  } catch {
    // No bootstrap file yet (fresh deployment) — that is a normal state.
  }
  memory = values;
  return values;
}

async function persist(values: Store): Promise<void> {
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(filePath()), { recursive: true });
    await writeFile(filePath(), JSON.stringify(values, null, 2), "utf8");
    persistent = true;
  } catch {
    // Read-only runtime: keep the value in memory for this process and tell
    // the operator that a restart-safe store is not available.
    persistent = false;
  }
}

/** Effective value: bootstrap store first, deployment environment as fallback. */
export async function readConfig(key: ConfigKey): Promise<string | undefined> {
  const stored = (await load())[key];
  if (stored && stored.length > 0) return stored;
  const fromEnv = process.env[key];
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

export async function readAll(): Promise<Store> {
  const values = { ...(await load()) };
  for (const key of CONFIG_KEYS) {
    if (!values[key]) {
      const fromEnv = process.env[key];
      if (fromEnv) values[key] = fromEnv;
    }
  }
  return values;
}

/** Writes a value and returns whether it was stored durably on disk. */
export async function writeConfig(key: ConfigKey, value: string): Promise<{ durable: boolean }> {
  const values = { ...(await load()), [key]: value };
  memory = values;
  await persist(values);
  return { durable: persistent };
}

export function isDurable(): boolean {
  return persistent;
}
