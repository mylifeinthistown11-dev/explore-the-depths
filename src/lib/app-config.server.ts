/**
 * Server-only configuration layer for the six system configuration values.
 *
 * Source of truth is the BOOTSTRAP store (see bootstrap-store.server.ts), which
 * does not depend on the application database — so /configuration keeps working
 * on a fresh deployment with no database configured at all. Deployment
 * environment variables are used as a fallback. Secrets never leave this module.
 */
import { CONFIG_KEYS, readAll, readConfig, writeConfig, isDurable } from "./bootstrap-store.server";
import { applyOwnDbOverrides } from "./own-db.server";

export { CONFIG_KEYS };
export type ConfigKey = (typeof CONFIG_KEYS)[number];

/** Pushes the currently configured database credentials into the data layer. */
async function syncRuntime(): Promise<void> {
  const values = await readAll();
  applyOwnDbOverrides({
    dbUrl: values["OWN_SUPABASE_DB_URL"] ?? null,
    serviceRoleKey: values["OWN_SUPABASE_SERVICE_ROLE_KEY"] ?? null,
  });
}

/** Effective value for a configuration key (bootstrap store, else env). */
export async function getConfig(key: ConfigKey): Promise<string | undefined> {
  return readConfig(key);
}

/** True when the application has enough configuration to reach its database. */
export async function isConfigured(): Promise<boolean> {
  const values = await readAll();
  return Boolean(values["OWN_SUPABASE_DB_URL"] && values["OWN_SUPABASE_SERVICE_ROLE_KEY"]);
}

/** Status only — no secret value is ever returned. */
export async function getConfigStatus(): Promise<{
  mode: "BOOTSTRAP" | "NORMAL";
  durableStore: boolean;
  configured: Record<ConfigKey, boolean>;
  adminEmail: string;
  database: { configured: boolean; connected: boolean; reason?: string };
}> {
  const values = await readAll();
  const configured = {} as Record<ConfigKey, boolean>;
  for (const key of CONFIG_KEYS) configured[key] = Boolean(values[key]);

  await syncRuntime();

  const dbUrl = values["OWN_SUPABASE_DB_URL"];
  let database: { configured: boolean; connected: boolean; reason?: string } = {
    configured: Boolean(dbUrl),
    connected: false,
  };
  if (dbUrl) {
    const result = await testDatabaseUrl(dbUrl);
    database = {
      configured: true,
      connected: result.ok,
      ...(result.reason ? { reason: result.reason } : {}),
    };
  }

  return {
    mode: (await isConfigured()) ? "NORMAL" : "BOOTSTRAP",
    durableStore: isDurable(),
    configured,
    adminEmail: values["ADMIN_EMAIL"] ?? "",
    database,
  };
}

/** Persists a configuration value and reinitialises the runtime services. */
export async function setConfig(key: ConfigKey, value: string): Promise<{ durable: boolean }> {
  const result = await writeConfig(key, value);
  await syncRuntime();
  return result;
}

/** Cryptographically secure secret, generated server-side. */
export function generateSessionSecret(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Opens a real PostgreSQL connection with the supplied connection string and
 * runs a trivial query. No Supabase client and no Lovable Cloud involved.
 */
export async function testDatabaseUrl(dbUrl: string): Promise<{ ok: boolean; reason?: string }> {
  const raw = dbUrl.trim();
  let parsed: URL | null = null;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = null;
  }
  const validScheme = parsed !== null && /^postgres(ql)?:$/i.test(parsed.protocol);
  if (!validScheme || !parsed?.hostname) {
    return { ok: false, reason: "Invalid database connection URL." };
  }


  type PgHandle = {
    unsafe: (q: string) => Promise<unknown>;
    end: (options?: { timeout?: number }) => Promise<void>;
  };
  let sql: PgHandle | null = null;
  try {
    const { default: postgres } = await import("postgres");
    sql = postgres(raw, {
      max: 1,
      idle_timeout: 2,
      connect_timeout: 8,
      prepare: false,
      onnotice: () => {},
    }) as unknown as PgHandle;
    await sql.unsafe("select 1");
    return { ok: true };
  } catch (error) {
    // Server-side only, and never with credentials in it.
    console.warn(
      "[configuration] database connection test failed",
      (error as { code?: string } | null)?.code ?? "UNKNOWN",
    );
    return {
      ok: false,
      reason: "Unable to connect to the database. Please check the database URL and try again.",
    };
  } finally {
    try {
      await sql?.end({ timeout: 1 });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Validates the service-role key against the database project derived from the
 * supplied connection string. Never logs or returns the key itself.
 */
export async function testServiceRoleKey(
  key: string,
  dbUrl?: string,
): Promise<{ ok: boolean; reason?: string }> {
  const value = key.trim();
  if (!value) return { ok: false, reason: "Enter a service-role key." };

  const { projectUrlFromDbUrl } = await import("./own-db.server");
  const connection = dbUrl?.trim() || (await readConfig("OWN_SUPABASE_DB_URL")) || "";
  const projectUrl = projectUrlFromDbUrl(connection);
  if (!projectUrl) {
    // Nothing to validate against yet — the key is simply stored configuration.
    return {
      ok: true,
      reason:
        "Service key saved. Validation will occur when the application connects to the configured service.",
    };
  }
  try {
    const response = await fetch(`${projectUrl}/rest/v1/`, {
      headers: { apikey: value, Accept: "application/json" },
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: "The service key was rejected. Please check the value." };
    }
    if (response.status >= 500) {
      return {
        ok: false,
        reason: "The service is temporarily unavailable. Please try again shortly.",
      };
    }
    return { ok: true, reason: "Service role key accepted" };
  } catch {
    console.warn("[configuration] service key verification endpoint unreachable");
    return {
      ok: false,
      reason: "Unable to reach the configured service. Please check the details and try again.",
    };
  }
}
