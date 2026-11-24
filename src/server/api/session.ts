// Сессия кабинета: в базе только хэши токенов, сам токен лежит в cookie HttpOnly.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../../db/client.js";
import { users, webSessions } from "../../db/schema.js";
import { constantTimeEqual } from "../../linking/secrets.js";

export const SESSION_COOKIE = "eb_session";
export const CSRF_COOKIE = "eb_csrf";
export const LOGIN_COOKIE = "eb_login";
export const NO_ACCESS_COOKIE = "eb_no_access";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LAST_SEEN_STEP_MS = 5 * 60 * 1000;

export type SessionUser = typeof users.$inferSelect;
export type ActiveSession = { sessionId: number; csrfTokenHash: string; user: SessionUser };

const sha256 = (value: string) => createHash("sha256").update(value).digest("base64url");
const newToken = () => randomBytes(32).toString("base64url");

export type CookieOptions = { secure: boolean };

export function cookieFlags(options: CookieOptions, path = "/") {
  return { path, httpOnly: true, secure: options.secure, sameSite: "lax" as const };
}

export function setCsrfCookie(reply: FastifyReply, token: string, options: CookieOptions) {
  reply.setCookie(CSRF_COOKIE, token, { ...cookieFlags(options), maxAge: SESSION_TTL_MS / 1000 });
}

export function clearSessionCookies(reply: FastifyReply, options: CookieOptions) {
  reply.clearCookie(SESSION_COOKIE, cookieFlags(options));
  reply.clearCookie(CSRF_COOKIE, cookieFlags(options));
}

export async function createSession(db: Db, reply: FastifyReply, userId: number, options: CookieOptions) {
  const token = newToken();
  const csrfToken = newToken();
  await db.insert(webSessions).values({
    userId,
    tokenHash: sha256(token),
    csrfTokenHash: sha256(csrfToken),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  reply.setCookie(SESSION_COOKIE, token, { ...cookieFlags(options), maxAge: SESSION_TTL_MS / 1000 });
  setCsrfCookie(reply, csrfToken, options);
}

export async function revokeSessionByCookie(db: Db, request: FastifyRequest) {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return;
  await db.update(webSessions).set({ revokedAt: new Date() }).where(eq(webSessions.tokenHash, sha256(token)));
}

export async function resolveSession(db: Db, request: FastifyRequest): Promise<ActiveSession | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const now = new Date();
  const [row] = await db
    .select({ session: webSessions, user: users })
    .from(webSessions)
    .innerJoin(users, eq(users.id, webSessions.userId))
    .where(and(eq(webSessions.tokenHash, sha256(token)), isNull(webSessions.revokedAt), gt(webSessions.expiresAt, now)));
  if (!row) return null;
  if (!row.session.lastSeenAt || now.getTime() - row.session.lastSeenAt.getTime() > LAST_SEEN_STEP_MS) {
    await db.update(webSessions).set({ lastSeenAt: now }).where(eq(webSessions.id, row.session.id));
  }
  return { sessionId: row.session.id, csrfTokenHash: row.session.csrfTokenHash, user: row.user };
}

export function csrfMatches(session: ActiveSession, header: unknown): boolean {
  return typeof header === "string" && header !== "" && constantTimeEqual(sha256(header), session.csrfTokenHash);
}

/** CSRF-токен для ответа /me: из cookie, а если её нет или она устарела — новый. */
export async function currentCsrfToken(
  db: Db,
  request: FastifyRequest,
  reply: FastifyReply,
  session: ActiveSession,
  options: CookieOptions,
): Promise<string> {
  const existing = request.cookies[CSRF_COOKIE];
  if (existing && csrfMatches(session, existing)) return existing;
  const token = newToken();
  await db.update(webSessions).set({ csrfTokenHash: sha256(token) }).where(eq(webSessions.id, session.sessionId));
  setCsrfCookie(reply, token, options);
  return token;
}

// ---------- Подписанные значения в cookie: параметры входа и экран «нет доступа» ----------

function signature(secret: string, purpose: string, encoded: string) {
  return createHmac("sha256", secret).update(`cookie:${purpose}`).update("\0").update(encoded).digest("base64url");
}

export function signValue(secret: string, purpose: string, value: object, expiresAt: number): string {
  const encoded = Buffer.from(JSON.stringify({ ...value, exp: expiresAt })).toString("base64url");
  return `${encoded}.${signature(secret, purpose, encoded)}`;
}

export function readSigned(secret: string, purpose: string, raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  const [encoded, mac, extra] = raw.split(".");
  if (!encoded || !mac || extra !== undefined) return null;
  if (!constantTimeEqual(signature(secret, purpose, encoded), mac)) return null;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
    return typeof value.exp === "number" && value.exp > Date.now() ? value : null;
  } catch {
    return null;
  }
}
