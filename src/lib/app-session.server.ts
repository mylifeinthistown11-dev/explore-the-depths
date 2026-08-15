/**
 * Session handling for the platform's own authentication.
 * A signed JWT lives in an httpOnly cookie; every token is mirrored as a row in
 * the existing `sessions` table so admins can revoke and single-session policy
 * can be enforced.
 */
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { getRequestHeader, setResponseHeader } from "@tanstack/react-start/server";
import { newId, nowIso, ownDb } from "./own-db.server";

const COOKIE = "cc2026_session";
const MAX_AGE_SECONDS = 60 * 60 * 12;

export type SessionClaims = {
  sub: string; // users.id
  role: "ADMIN" | "STUDENT";
  studentId: string | null; // students.id
  jti: string;
};

async function secretKey(): Promise<Uint8Array> {
  const { getConfig } = await import("./app-config.server");
  const secret = await getConfig("APP_SESSION_SECRET");
  if (!secret) throw new Error("Sessions are not configured (APP_SESSION_SECRET missing).");
  return new TextEncoder().encode(secret);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

function isSecureRequest(): boolean {
  const proto = getRequestHeader("x-forwarded-proto");
  if (proto) return proto.split(",")[0]?.trim() === "https";
  const host = getRequestHeader("host") ?? "";
  // Plain-HTTP localhost development would silently drop a `Secure` cookie.
  return !/^(localhost|127\.0\.0\.1)(:|$)/.test(host);
}

function serializeCookie(value: string, maxAge: number): string {
  return [
    `${COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...(isSecureRequest() ? ["Secure"] : []),
    `Max-Age=${maxAge}`,
  ].join("; ");
}

function readCookie(): string | null {
  const raw = getRequestHeader("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return null;
}

/**
 * Issues a session. In one round-trip it revokes every session row that is not
 * already revoked for this user — expired/stale rows as well as a genuinely
 * live one on another device — so the newest sign-in always wins and nobody is
 * ever locked out by a leftover row. Then it records the new session and sets
 * the cookie.
 */
export async function startSession(input: {
  userId: string;
  role: "ADMIN" | "STUDENT";
  studentId: string | null;
}): Promise<{ terminatedOther: boolean }> {
  const db = ownDb();
  const jti = newId();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + MAX_AGE_SECONDS * 1000).toISOString();

  const { data: cleared } = await db
    .from("sessions")
    .update({ isRevoked: true, revokedAt: now, updatedAt: now })
    .eq("userId", input.userId)
    .eq("isRevoked", false)
    .select("expiresAt");

  // Every previously cached jti for this user may now be revoked.
  invalidateSessionCache();

  // Only a row that had not expired yet counts as "another device was active".
  const terminatedOther = (cleared ?? []).some(
    (row) => new Date(String(row["expiresAt"])) > new Date(),
  );


  const { error } = await db.from("sessions").insert({
    id: newId(),
    userId: input.userId,
    studentId: input.studentId,
    tokenJti: jti,
    ipAddress: getRequestHeader("x-forwarded-for") ?? null,
    userAgent: getRequestHeader("user-agent") ?? null,
    isRevoked: false,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });
  if (error) {
    console.error("[session] insert failed", error.message);
    throw new Error("Could not start your session.");
  }

  const token = await new SignJWT({ role: input.role, studentId: input.studentId, jti })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(input.userId)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(await secretKey());

  setResponseHeader("Set-Cookie", serializeCookie(token, MAX_AGE_SECONDS));
  return { terminatedOther };
}



/**
 * Session-row validity cache. Every server function validates the session, so
 * an uncached lookup added a database round trip to every single request. A
 * short TTL keeps revocation effectively immediate while removing that cost.
 */
const SESSION_CACHE_MS = 10_000;
const sessionCache = new Map<string, { at: number; valid: boolean }>();

/** Drops a jti from the validity cache so revocation applies immediately. */
export function invalidateSessionCache(jti?: string): void {
  if (jti) sessionCache.delete(jti);
  else sessionCache.clear();
}

async function isSessionRowValid(jti: string): Promise<boolean> {
  const cached = sessionCache.get(jti);
  if (cached && Date.now() - cached.at < SESSION_CACHE_MS) return cached.valid;

  const { data: row } = await ownDb()
    .from("sessions")
    .select("id, isRevoked, expiresAt")
    .eq("tokenJti", jti)
    .maybeSingle();
  const valid = Boolean(
    row && !row["isRevoked"] && new Date(String(row["expiresAt"])) >= new Date(),
  );
  sessionCache.set(jti, { at: Date.now(), valid });
  // Bound the map on long-running processes.
  if (sessionCache.size > 5000) {
    for (const [key, entry] of sessionCache) {
      if (Date.now() - entry.at > SESSION_CACHE_MS) sessionCache.delete(key);
    }
  }
  return valid;
}

/** Reads and validates the current session, or returns null. */
export async function readSession(): Promise<SessionClaims | null> {
  const token = readCookie();
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, await secretKey());
    const claims: SessionClaims = {
      sub: String(payload.sub),
      role: payload["role"] === "ADMIN" ? "ADMIN" : "STUDENT",
      studentId: (payload["studentId"] as string | null) ?? null,
      jti: String(payload["jti"]),
    };

    if (!(await isSessionRowValid(claims.jti))) return null;
    return claims;
  } catch {
    return null;
  }
}


export async function requireSession(): Promise<SessionClaims> {
  const claims = await readSession();
  if (!claims) throw new Error("Your session has expired. Please sign in again.");
  return claims;
}

export async function requireAdmin(): Promise<SessionClaims> {
  const claims = await requireSession();
  if (claims.role !== "ADMIN") throw new Error("Forbidden: administrator access is required.");
  return claims;
}

export async function requireStudent(): Promise<SessionClaims & { studentId: string }> {
  const claims = await requireSession();
  if (claims.role !== "STUDENT" || !claims.studentId) throw new Error("Forbidden: this action is only available to students.");
  return claims as SessionClaims & { studentId: string };
}

/** Revokes the current session and clears the cookie. */
export async function endSession(): Promise<void> {
  const claims = await readSession();
  if (claims) {
    await ownDb()
      .from("sessions")
      .update({ isRevoked: true, revokedAt: nowIso(), updatedAt: nowIso() })
      .eq("tokenJti", claims.jti);
  }
  setResponseHeader("Set-Cookie", serializeCookie("", 0));
}
