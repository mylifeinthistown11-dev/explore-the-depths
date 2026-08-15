import { CONFIG_KEYS, readBootstrap, writeBootstrap, type BootstrapStore } from "./bootstrap-store.server";
import { applyOwnDbOverrides, projectUrlFromDbUrl } from "./own-db.server";

export { CONFIG_KEYS };
export type ConfigKey = (typeof CONFIG_KEYS)[number];

type ConfigurationStatus = {
  configured: boolean;
  mode: "BOOTSTRAP" | "NORMAL";
  durableStore: boolean;
  fields: Record<ConfigKey, boolean>;
  adminEmail: string;
  database: { configured: boolean; connected: boolean; reason?: string };
};

type PgClient = {
  unsafe: (query: string, parameters?: unknown[]) => Promise<Record<string, unknown>[]>;
  end: (options?: { timeout?: number }) => Promise<void>;
};

const TABLE_SQL = `
  create schema if not exists codearena_private;
  create table if not exists codearena_private.application_configuration (
    key text primary key,
    value text not null,
    updated_at timestamptz not null default now(),
    constraint application_configuration_key_check check (key in (
      'APP_SESSION_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD',
      'DEFAULT_STUDENT_PASSWORD', 'OWN_SUPABASE_DB_URL',
      'OWN_SUPABASE_SERVICE_ROLE_KEY'
    ))
  )
`;

function isComplete(values: BootstrapStore): boolean {
  return CONFIG_KEYS.every((key) => Boolean(values[key]));
}

async function openDatabase(databaseUrl: string): Promise<PgClient> {
  const { default: postgres } = await import("postgres");
  return postgres(databaseUrl, {
    max: 1,
    idle_timeout: 2,
    connect_timeout: 8,
    prepare: false,
    onnotice: () => {},
  }) as unknown as PgClient;
}

async function readDatabaseStore(databaseUrl: string): Promise<BootstrapStore> {
  const sql = await openDatabase(databaseUrl);
  try {
    await sql.unsafe(TABLE_SQL);
    const rows = await sql.unsafe(
      "select key, value from codearena_private.application_configuration",
    );
    const values: BootstrapStore = {};
    for (const row of rows) {
      const key = row["key"];
      const value = row["value"];
      if (CONFIG_KEYS.includes(key as ConfigKey) && typeof value === "string" && value) {
        values[key as ConfigKey] = value;
      }
    }
    return values;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => undefined);
  }
}

async function writeDatabaseStore(databaseUrl: string, values: BootstrapStore): Promise<void> {
  const sql = await openDatabase(databaseUrl);
  try {
    await sql.unsafe(TABLE_SQL);
    for (const key of CONFIG_KEYS) {
      const value = values[key];
      if (!value) continue;
      await sql.unsafe(
        `insert into codearena_private.application_configuration (key, value, updated_at)
         values ($1, $2, now())
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [key, value],
      );
    }
  } finally {
    await sql.end({ timeout: 1 }).catch(() => undefined);
  }
}

class ConfigurationService {
  private async load(): Promise<{ values: BootstrapStore; connected: boolean; durable: boolean }> {
    const bootstrap = await readBootstrap();
    const bootstrapUrl = bootstrap["OWN_SUPABASE_DB_URL"];
    const bootstrapKey = bootstrap["OWN_SUPABASE_SERVICE_ROLE_KEY"];

    applyOwnDbOverrides({ dbUrl: bootstrapUrl ?? null, serviceRoleKey: bootstrapKey ?? null });

    if (!bootstrapUrl) return { values: bootstrap, connected: false, durable: false };

    try {
      const stored = await readDatabaseStore(bootstrapUrl);
      const values = { ...bootstrap, ...stored };
      applyOwnDbOverrides({
        dbUrl: values["OWN_SUPABASE_DB_URL"] ?? null,
        serviceRoleKey: values["OWN_SUPABASE_SERVICE_ROLE_KEY"] ?? null,
      });

      // First successful connection migrates deployment/bootstrap values into
      // PostgreSQL. This is idempotent and never deletes an existing value.
      if (Object.keys(bootstrap).length > 0) await writeDatabaseStore(bootstrapUrl, values);
      return { values, connected: true, durable: true };
    } catch (error) {
      if (isComplete(bootstrap)) {
        console.warn("[configuration] PostgreSQL configuration store is temporarily unavailable");
        return { values: bootstrap, connected: false, durable: true };
      }
      throw new Error("The persistent configuration store is temporarily unavailable.", {
        cause: error,
      });
    }
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async get(key: ConfigKey): Promise<string | undefined> {
    return (await this.load()).values[key];
  }

  async set(key: ConfigKey, value: string): Promise<{ durable: true }> {
    const current = await this.load();
    const values = { ...current.values, [key]: value };
    const databaseUrl = values["OWN_SUPABASE_DB_URL"];

    if (databaseUrl) {
      await writeDatabaseStore(databaseUrl, values);
      // Keep the bootstrap pointer restart-safe for local/persistent-volume
      // deployments. Deployment secrets remain the fallback on hosted runs.
      try {
        await writeBootstrap(values);
      } catch {
        // PostgreSQL is already the durable source of truth.
      }
      applyOwnDbOverrides({
        dbUrl: databaseUrl,
        serviceRoleKey: values["OWN_SUPABASE_SERVICE_ROLE_KEY"] ?? null,
      });
      return { durable: true };
    }

    await writeBootstrap(values);
    return { durable: true };
  }

  async isConfigured(): Promise<boolean> {
    return isComplete((await this.load()).values);
  }

  async getStatus(): Promise<ConfigurationStatus> {
    const state = await this.load();
    const fields = {} as Record<ConfigKey, boolean>;
    for (const key of CONFIG_KEYS) fields[key] = Boolean(state.values[key]);
    const configured = isComplete(state.values);
    return {
      configured,
      mode: configured ? "NORMAL" : "BOOTSTRAP",
      durableStore: state.durable,
      fields,
      adminEmail: state.values["ADMIN_EMAIL"] ?? "",
      database: {
        configured: Boolean(state.values["OWN_SUPABASE_DB_URL"]),
        connected: state.connected,
        ...(!state.connected && state.values["OWN_SUPABASE_DB_URL"]
          ? { reason: "Database connection is temporarily unavailable." }
          : {}),
      },
    };
  }
}

export const configurationService = new ConfigurationService();

// Compatibility exports keep existing backend modules on the one service.
export async function getConfig(key: ConfigKey): Promise<string | undefined> {
  return configurationService.get(key);
}

export async function setConfig(key: ConfigKey, value: string): Promise<{ durable: true }> {
  return configurationService.set(key, value);
}

export async function isConfigured(): Promise<boolean> {
  return configurationService.isConfigured();
}

export async function getConfigStatus(): Promise<{
  configured: Record<ConfigKey, boolean>;
  applicationConfigured: boolean;
  mode: "BOOTSTRAP" | "NORMAL";
  durableStore: boolean;
  adminEmail: string;
  database: { configured: boolean; connected: boolean; reason?: string };
}> {
  const status = await configurationService.getStatus();
  return {
    configured: status.fields,
    applicationConfigured: status.configured,
    mode: status.mode,
    durableStore: status.durableStore,
    adminEmail: status.adminEmail,
    database: status.database,
  };
}

export function generateSessionSecret(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function testDatabaseUrl(dbUrl: string): Promise<{ ok: boolean; reason?: string }> {
  const raw = dbUrl.trim();
  try {
    const parsed = new URL(raw);
    if (!/^postgres(ql)?:$/i.test(parsed.protocol) || !parsed.hostname) throw new Error("invalid");
  } catch {
    return { ok: false, reason: "Invalid database connection URL." };
  }
  let sql: PgClient | null = null;
  try {
    sql = await openDatabase(raw);
    await sql.unsafe("select 1");
    return { ok: true };
  } catch {
    return { ok: false, reason: "Unable to connect to the database. Please check the database URL and try again." };
  } finally {
    await sql?.end({ timeout: 1 }).catch(() => undefined);
  }
}

export async function testServiceRoleKey(key: string, dbUrl?: string): Promise<{ ok: boolean; reason?: string }> {
  const value = key.trim();
  if (!value) return { ok: false, reason: "Enter a service-role key." };
  const connection = dbUrl?.trim() || (await configurationService.get("OWN_SUPABASE_DB_URL")) || "";
  const projectUrl = projectUrlFromDbUrl(connection);
  if (!projectUrl) return { ok: true, reason: "Service key saved. Validation will occur when the application connects." };
  try {
    const response = await fetch(`${projectUrl}/rest/v1/`, { headers: { apikey: value, Accept: "application/json" } });
    if (response.status === 401 || response.status === 403) return { ok: false, reason: "The service key was rejected." };
    if (response.status >= 500) return { ok: false, reason: "The service is temporarily unavailable." };
    return { ok: true, reason: "Service role key accepted" };
  } catch {
    return { ok: false, reason: "Unable to reach the configured service." };
  }
}