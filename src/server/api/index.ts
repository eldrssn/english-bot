// HTTP API кабинета. Маршруты объявляются только через teacherRoute, studentRoute и resourceRoute:
// они единообразно проверяют сессию, роль, CSRF и право на объект :id на каждом запросе.
import { eq, and, ne } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { Db } from "../../db/client.js";
import { studentLinks, users } from "../../db/schema.js";
import { LinkingError, createLinkingService } from "../../linking/service.js";
import { constantTimeEqual } from "../../linking/secrets.js";
import { getDashboard, getRequest, getStudentDetail, listStudents } from "../../linking/views.js";
import { createCopyService } from "../../materials/copies.js";
import { MaterialsError } from "../../materials/errors.js";
import { createIssueService } from "../../materials/issue.js";
import { createSourceService } from "../../materials/source.js";
import { CSRF_HEADER, apiRoutes, type LoginErrorCode, type MeResponse } from "../../shared/api-contract.js";
import { RateLimiter } from "../rate-limit.js";
import { ApiFailure, errorBody } from "./errors.js";
import {
  buildAuthorizationUrl,
  exchangeCode,
  newLoginParams,
  verifyIdToken,
  type TelegramIdentity,
  type TelegramLogin,
} from "./login.js";
import {
  LOGIN_COOKIE,
  NO_ACCESS_COOKIE,
  clearSessionCookies,
  cookieFlags,
  createSession,
  csrfMatches,
  currentCsrfToken,
  readSigned,
  resolveSession,
  revokeSessionByCookie,
  signValue,
  type ActiveSession,
  type SessionUser,
} from "./session.js";

const LOGIN_STATE_TTL_MS = 10 * 60 * 1000;
const NO_ACCESS_TTL_MS = 10 * 60 * 1000;
const LOGIN_RATE = { max: 20, windowMs: 60_000 };
const CODE_RATE = { max: 10, windowMs: 60_000 };
const IMPORT_BODY_LIMIT = 4 * 1024 * 1024;

export type ApiOptions = {
  appSecret: string;
  isProduction: boolean;
  /** Для адреса ссылки https://t.me/<бот>?start=<токен>. */
  botUsername: string;
  /** null: настоящий вход не настроен. */
  login: TelegramLogin | null;
  devLoginTelegramId: number | null;
};

type RouteSpec = { method: string; path: string; response: z.ZodType; body?: z.ZodType };
type BodyOf<S extends RouteSpec> = S["body"] extends z.ZodType ? z.output<S["body"]> : undefined;
type TeacherContext<S extends RouteSpec> = {
  teacher: SessionUser;
  body: BodyOf<S>;
  request: FastifyRequest;
  reply: FastifyReply;
};
type StudentContext<S extends RouteSpec> = TeacherContext<S> & { linkId: number };
type ResourceAccess = "own-collection" | "own-source-card" | "own-copy" | "own-copy-card";
type ResourceContext<S extends RouteSpec> = TeacherContext<S> & { id: number };
/** Своя запись по :id или null. Чужая, удалённая и несуществующая неотличимы. */
type ResourceResolver = (teacherUserId: number, id: number) => Promise<number | null>;

const isMutation = (method: string) => method !== "GET" && method !== "HEAD";

export async function registerApi(app: FastifyInstance, db: Db, options: ApiOptions) {
  const linking = createLinkingService(db, options.appSecret);
  const sources = createSourceService(db);
  const issuing = createIssueService(db);
  const copies = createCopyService(db);
  const cookies = { secure: options.isProduction };
  const loginLimiter = new RateLimiter(LOGIN_RATE.max, LOGIN_RATE.windowMs);
  const codeLimiter = new RateLimiter(CODE_RATE.max, CODE_RATE.windowMs);

  const limit = (limiter: RateLimiter, key: string) => {
    const retryAfterSeconds = limiter.hit(key);
    if (retryAfterSeconds !== null) throw new ApiFailure("rate_limited", { retryAfterSeconds });
  };

  app.addHook("onSend", async (_request, reply) => {
    reply.header("cache-control", "no-store");
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiFailure) {
      if (error.extra.retryAfterSeconds) reply.header("retry-after", error.extra.retryAfterSeconds);
      return reply.code(error.status).send(errorBody(error.code, error.extra.attemptsLeft, error.extra.details));
    }
    if (error instanceof MaterialsError) {
      const failure = new ApiFailure(error.code);
      return reply.code(failure.status).send(errorBody(error.code, undefined, error.details));
    }
    if (error instanceof LinkingError) {
      const failure = new ApiFailure(error.code);
      return reply.code(failure.status).send(errorBody(error.code));
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.code(status).send(errorBody("bad_request"));
    }
    request.log.error(error);
    return reply.code(500).send(errorBody("internal"));
  });

  /** Сессия, роль, затем CSRF. Роль читается из базы на каждом запросе: снятая роль действует сразу. */
  async function requireTeacher(request: FastifyRequest): Promise<ActiveSession> {
    const session = await resolveSession(db, request);
    if (!session) throw new ApiFailure("unauthorized");
    if (session.user.role !== "teacher") throw new ApiFailure("no_access");
    if (isMutation(request.method) && !csrfMatches(session, request.headers[CSRF_HEADER])) {
      throw new ApiFailure("csrf_failed");
    }
    return session;
  }

  function parseBody<S extends RouteSpec>(spec: S, request: FastifyRequest): BodyOf<S> {
    if (!spec.body) return undefined as BodyOf<S>;
    const parsed = spec.body.safeParse(request.body);
    if (!parsed.success) throw new ApiFailure("bad_request");
    return parsed.data as BodyOf<S>;
  }

  function teacherRoute<S extends RouteSpec>(
    spec: S,
    handler: (context: TeacherContext<S>) => Promise<z.input<S["response"]>>,
  ) {
    app.route({
      method: spec.method as "GET",
      url: spec.path,
      handler: async (request, reply) => {
        const session = await requireTeacher(request);
        const body = parseBody(spec, request);
        const result = await handler({ teacher: session.user, body, request, reply });
        return spec.response.parse(result);
      },
    });
  }

  /**
   * Единая проверка права преподавателя на запись ученика. Выполняется до разбора тела:
   * чужая, завершённая и несуществующая записи дают одинаковый ответ, что бы ни прислал клиент.
   */
  function parseId(rawId: unknown): number {
    if (typeof rawId !== "string" || !/^[1-9]\d{0,14}$/.test(rawId)) throw new ApiFailure("not_found");
    return Number(rawId);
  }

  async function requireOwnLink(teacherUserId: number, rawId: unknown): Promise<number> {
    const linkId = parseId(rawId);
    const [own] = await db
      .select({ id: studentLinks.id })
      .from(studentLinks)
      .where(
        and(eq(studentLinks.id, linkId), eq(studentLinks.teacherUserId, teacherUserId), ne(studentLinks.status, "ended")),
      );
    if (!own) throw new ApiFailure("not_found");
    return own.id;
  }

  function studentRoute<S extends RouteSpec>(
    spec: S,
    handler: (context: StudentContext<S>) => Promise<z.input<S["response"]>>,
    guard?: (teacher: SessionUser) => void,
  ) {
    app.route({
      method: spec.method as "GET",
      url: spec.path,
      handler: async (request, reply) => {
        const session = await requireTeacher(request);
        guard?.(session.user);
        const linkId = await requireOwnLink(session.user.id, (request.params as { id?: unknown }).id);
        const body = parseBody(spec, request);
        const result = await handler({ teacher: session.user, linkId, body, request, reply });
        return spec.response.parse(result);
      },
    });
  }

  /**
   * Маршрут к своему объекту :id (подборка, карточка, копия). Права проверяются до разбора тела,
   * как у studentRoute; сервис повторяет проверку под блокировкой.
   */
  function resourceRoute<S extends RouteSpec & { access: ResourceAccess }>(
    spec: S,
    handler: (context: ResourceContext<S>) => Promise<z.input<S["response"]>>,
    options: { bodyLimit?: number } = {},
  ) {
    const resolve = resolvers[spec.access];
    app.route({
      method: spec.method as "GET",
      url: spec.path,
      ...options,
      handler: async (request, reply) => {
        const session = await requireTeacher(request);
        const id = await resolve(session.user.id, parseId((request.params as { id?: unknown }).id));
        if (id === null) throw new ApiFailure("not_found");
        const body = parseBody(spec, request);
        const result = await handler({ teacher: session.user, id, body, request, reply });
        return spec.response.parse(result);
      },
    });
  }

  /** Проверка права по виду доступа из контракта: маршрут не может объявить одно, а проверять другое. */
  const resolvers: Record<ResourceAccess, ResourceResolver> = {
    "own-collection": async (teacherUserId, id) => ((await sources.exists(teacherUserId, id)) ? id : null),
    "own-source-card": async (teacherUserId, id) => ((await sources.collectionOfCard(teacherUserId, id)) === null ? null : id),
    "own-copy": (teacherUserId, id) => copies.findCopy(teacherUserId, id),
    "own-copy-card": async (teacherUserId, id) => ((await copies.copyOfCard(teacherUserId, id)) === null ? null : id),
  };

  const inviteUrl = (token: string) => `https://t.me/${options.botUsername}?start=${token}`;
  const inviteResponse = (invitation: { token: string; expiresAt: Date }) => ({
    url: inviteUrl(invitation.token),
    expiresAt: invitation.expiresAt.toISOString(),
  });

  async function detailOrNotFound(teacherUserId: number, linkId: number) {
    const detail = await getStudentDetail(db, teacherUserId, linkId);
    if (!detail) throw new ApiFailure("not_found");
    return detail;
  }

  // ---------- Вход и выход ----------

  const loginErrorRedirect = (reply: FastifyReply, code: LoginErrorCode) => reply.redirect(`/?login_error=${code}`);

  /** Завершает вход: сессия только у преподавателя; остальные увидят «нет доступа» без доступа к данным. */
  async function finishLogin(request: FastifyRequest, reply: FastifyReply, identity: TelegramIdentity) {
    const profile = {
      ...(identity.firstName === null ? {} : { telegramFirstName: identity.firstName }),
      ...(identity.lastName === null ? {} : { telegramLastName: identity.lastName }),
      ...(identity.username === null ? {} : { telegramUsername: identity.username }),
    };
    const [user] = await db
      .insert(users)
      .values({ telegramId: identity.telegramId, ...profile })
      // Вход не меняет роль: в наборе полей её нет.
      .onConflictDoUpdate({ target: users.telegramId, set: { ...profile, botBlockedAt: null } })
      .returning();
    if (!user) throw new Error("Пользователь не сохранён");

    await revokeSessionByCookie(db, request);
    clearSessionCookies(reply, cookies);
    reply.clearCookie(NO_ACCESS_COOKIE, cookieFlags(cookies));

    if (user.role === "teacher") {
      await createSession(db, reply, user.id, cookies);
    } else {
      const expiresAt = Date.now() + NO_ACCESS_TTL_MS;
      const value = signValue(options.appSecret, "no-access", { telegramId: user.telegramId }, expiresAt);
      reply.setCookie(NO_ACCESS_COOKIE, value, { ...cookieFlags(cookies), maxAge: NO_ACCESS_TTL_MS / 1000 });
    }
    return reply.redirect("/");
  }

  app.get(apiRoutes.telegramLoginStart.path, async (request, reply) => {
    limit(loginLimiter, request.ip);
    if (!options.login) return loginErrorRedirect(reply, "not_configured");
    const params = newLoginParams();
    const value = signValue(options.appSecret, "login", params, Date.now() + LOGIN_STATE_TTL_MS);
    reply.setCookie(LOGIN_COOKIE, value, { ...cookieFlags(cookies, "/api/auth"), maxAge: LOGIN_STATE_TTL_MS / 1000 });
    return reply.redirect(buildAuthorizationUrl(options.login, params));
  });

  app.get(apiRoutes.telegramLoginCallback.path, async (request, reply) => {
    limit(loginLimiter, request.ip);
    if (!options.login) return loginErrorRedirect(reply, "not_configured");
    const query = request.query as { code?: unknown; state?: unknown; error?: unknown };
    const stored = readSigned(options.appSecret, "login", request.cookies[LOGIN_COOKIE]);
    // Параметры входа одноразовые.
    reply.clearCookie(LOGIN_COOKIE, cookieFlags(cookies, "/api/auth"));

    if (
      !stored ||
      typeof stored.state !== "string" ||
      typeof stored.nonce !== "string" ||
      typeof stored.codeVerifier !== "string" ||
      typeof query.state !== "string" ||
      !constantTimeEqual(stored.state, query.state)
    ) {
      return loginErrorRedirect(reply, "invalid_state");
    }
    if (query.error !== undefined) return loginErrorRedirect(reply, "denied");
    if (typeof query.code !== "string" || query.code === "") return loginErrorRedirect(reply, "failed");

    let identity: TelegramIdentity;
    try {
      const idToken = await exchangeCode(options.login, query.code, stored.codeVerifier);
      identity = await verifyIdToken(options.login, idToken, stored.nonce);
    } catch (error) {
      request.log.warn({ reason: (error as Error).name }, "Вход через Telegram не прошёл проверку");
      return loginErrorRedirect(reply, "failed");
    }
    return finishLogin(request, reply, identity);
  });

  const devLoginTelegramId = options.devLoginTelegramId;
  if (devLoginTelegramId !== null) {
    app.get(apiRoutes.devLogin.path, async (request, reply) =>
      finishLogin(request, reply, { telegramId: devLoginTelegramId, firstName: null, lastName: null, username: null }),
    );
  }

  app.get(apiRoutes.me.path, async (request, reply): Promise<MeResponse> => {
    const session = await resolveSession(db, request);
    if (session) {
      if (session.user.role !== "teacher") return { status: "no_access", telegramId: session.user.telegramId };
      return {
        status: "teacher",
        user: {
          telegramId: session.user.telegramId,
          name: [session.user.telegramFirstName, session.user.telegramLastName].filter(Boolean).join(" ") || null,
          username: session.user.telegramUsername,
        },
        csrfToken: await currentCsrfToken(db, request, reply, session, cookies),
      };
    }
    const noAccess = readSigned(options.appSecret, "no-access", request.cookies[NO_ACCESS_COOKIE]);
    if (typeof noAccess?.telegramId === "number") return { status: "no_access", telegramId: noAccess.telegramId };
    return { status: "anonymous", loginAvailable: options.login !== null, devLoginAvailable: devLoginTelegramId !== null };
  });

  app.post(apiRoutes.logout.path, async (request, reply) => {
    const session = await resolveSession(db, request);
    if (session) {
      if (!csrfMatches(session, request.headers[CSRF_HEADER])) throw new ApiFailure("csrf_failed");
      await revokeSessionByCookie(db, request);
    }
    clearSessionCookies(reply, cookies);
    reply.clearCookie(NO_ACCESS_COOKIE, cookieFlags(cookies));
    return { ok: true };
  });

  // ---------- Главная и список ----------

  teacherRoute(apiRoutes.dashboard, ({ teacher }) => getDashboard(db, teacher.id));

  teacherRoute(apiRoutes.listStudents, async ({ teacher }) => ({ students: await listStudents(db, teacher.id) }));

  teacherRoute(apiRoutes.createStudent, async ({ teacher, body }) => {
    const { linkId, invitation } = await linking.createStudent({
      teacherUserId: teacher.id,
      displayName: body.displayName,
    });
    return { student: await detailOrNotFound(teacher.id, linkId), invitation: inviteResponse(invitation) };
  });

  // ---------- Запись ученика ----------

  studentRoute(apiRoutes.getStudent, ({ teacher, linkId }) => detailOrNotFound(teacher.id, linkId));

  studentRoute(apiRoutes.renameStudent, async ({ teacher, linkId, body }) => {
    await linking.renameStudent({ teacherUserId: teacher.id, linkId, displayName: body.displayName });
    return detailOrNotFound(teacher.id, linkId);
  });

  studentRoute(apiRoutes.unlinkStudent, async ({ teacher, linkId }) => {
    await linking.unlinkStudent({ teacherUserId: teacher.id, linkId });
    return { ok: true as const };
  });

  studentRoute(apiRoutes.issueInvitation, async ({ teacher, linkId }) =>
    inviteResponse(await linking.issueInvitation({ teacherUserId: teacher.id, linkId })),
  );

  studentRoute(apiRoutes.revokeInvitation, async ({ teacher, linkId }) => {
    await linking.revokeInvitation({ teacherUserId: teacher.id, linkId });
    return detailOrNotFound(teacher.id, linkId);
  });

  studentRoute(apiRoutes.getRequest, async ({ teacher, linkId }) => {
    const result = await getRequest(db, teacher.id, linkId);
    if (!result) throw new ApiFailure("not_found");
    return result;
  });

  studentRoute(
    apiRoutes.approveRequest,
    async ({ teacher, linkId, body }) => {
      const result = await linking.approveRequest({ teacherUserId: teacher.id, linkId, code: body.code });
      if (result.kind === "wrong_code") throw new ApiFailure("wrong_code", { attemptsLeft: result.attemptsLeft });
      if (result.kind === "code_inactive") throw new ApiFailure("code_inactive", { attemptsLeft: 0 });
      return detailOrNotFound(teacher.id, linkId);
    },
    // Лимит на ввод кода стоит до проверки записи: перебор чужих ID упирается в него же.
    (teacher) => limit(codeLimiter, String(teacher.id)),
  );

  studentRoute(apiRoutes.rejectRequest, async ({ teacher, linkId }) => {
    await linking.rejectRequest({ teacherUserId: teacher.id, linkId });
    return detailOrNotFound(teacher.id, linkId);
  });

  // ---------- Исходные подборки ----------

  teacherRoute(apiRoutes.listCollections, ({ teacher }) => sources.list(teacher.id));

  teacherRoute(apiRoutes.createCollection, ({ teacher, body }) => sources.create(teacher.id, body.title));

  resourceRoute(apiRoutes.getCollection, ({ teacher, id }) => sources.detail(teacher.id, id));

  resourceRoute(apiRoutes.renameCollection, ({ teacher, id, body }) => sources.rename(teacher.id, id, body.title));

  resourceRoute(apiRoutes.deleteCollection, async ({ teacher, id }) => {
    await sources.remove(teacher.id, id);
    return { ok: true as const };
  });

  resourceRoute(apiRoutes.addCollectionCard, ({ teacher, id, body }) => sources.addCard(teacher.id, id, body));

  resourceRoute(apiRoutes.reorderCollectionCards, ({ teacher, id, body }) =>
    sources.reorder(teacher.id, id, body.cardIds),
  );

  resourceRoute(apiRoutes.editSourceCard, ({ teacher, id, body }) => sources.editCard(teacher.id, id, body));

  resourceRoute(apiRoutes.deleteSourceCard, async ({ teacher, id }) => {
    await sources.removeCard(teacher.id, id);
    return { ok: true as const };
  });

  // Вставка до 500 строк с примерами по-русски может превысить 1 МБ по умолчанию.
  resourceRoute(apiRoutes.importPreview, ({ teacher, id, body }) => sources.importPreview(teacher.id, id, body.text), {
    bodyLimit: IMPORT_BODY_LIMIT,
  });

  resourceRoute(apiRoutes.importCards, ({ teacher, id, body }) => sources.importCards(teacher.id, id, body.text), {
    bodyLimit: IMPORT_BODY_LIMIT,
  });

  resourceRoute(apiRoutes.issuePreview, ({ teacher, id, body }) => issuing.preview(teacher.id, id, body.studentIds));

  resourceRoute(apiRoutes.issueCollection, ({ teacher, id, body }) => issuing.issue(teacher.id, id, body.studentIds));

  // ---------- Копии учеников ----------

  resourceRoute(apiRoutes.getCopy, ({ teacher, id }) => copies.detail(teacher.id, id));

  resourceRoute(apiRoutes.withdrawCopy, async ({ teacher, id }) => {
    await copies.withdraw(teacher.id, id);
    return { ok: true as const };
  });

  resourceRoute(apiRoutes.addCopyCards, ({ teacher, id, body }) => copies.addCards(teacher.id, id, body.cards));

  resourceRoute(apiRoutes.editCopyCard, ({ teacher, id, body }) => copies.editCard(teacher.id, id, body));

  resourceRoute(apiRoutes.deleteCopyCard, ({ teacher, id }) => copies.removeCard(teacher.id, id));
}
