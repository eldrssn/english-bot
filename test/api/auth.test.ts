import { spawn } from "node:child_process";
import { count, eq } from "drizzle-orm";
import { UnsecuredJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { removeTeacherRole } from "../../src/admin/roles.js";
import { users, webSessions } from "../../src/db/schema.js";
import { LOGIN_SCOPE } from "../../src/server/api/login.js";
import { CSRF_COOKIE, LOGIN_COOKIE, NO_ACCESS_COOKIE, SESSION_COOKIE } from "../../src/server/api/session.js";
import { CSRF_HEADER, apiRoutes, meResponse } from "../../src/shared/api-contract.js";
import {
  BOT_ID,
  Browser,
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI,
  buildTestApp,
  createFakeOidc,
  loginAs,
  loginWith,
  type FakeOidc,
} from "../helpers/api.js";
import { openTestDb, resetDb } from "../helpers/db.js";
import { makeTeacher, makeUser } from "../helpers/linking.js";

const { db, close } = openTestDb();
afterAll(close);
beforeEach(() => resetDb(db));

let oidc: FakeOidc;
beforeAll(async () => {
  oidc = await createFakeOidc();
});
beforeEach(() => {
  oidc.state.tokenStatus = 200;
});

const TEACHER = 7000;
const app = () => buildTestApp(db, oidc);
const sessionCount = async () => (await db.select({ value: count() }).from(webSessions))[0]?.value;

describe("начало входа", () => {
  it("уводит на Telegram со всеми параметрами OIDC и PKCE", async () => {
    const browser = new Browser(app());
    const response = await browser.get(apiRoutes.telegramLoginStart.path);
    expect(response.statusCode).toBe(302);
    const url = new URL(response.headers.location as string);
    expect(url.origin + url.pathname).toBe("https://oauth.telegram.org/auth");
    const params = url.searchParams;
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(params.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(params.get("response_type")).toBe("code");
    expect(params.get("scope")).toBe(LOGIN_SCOPE);
    expect(params.get("scope")).toContain("telegram:bot_access");
    expect(params.get("code_challenge_method")).toBe("S256");
    for (const name of ["state", "nonce", "code_challenge"]) expect(params.get(name)?.length).toBeGreaterThan(20);

    const cookie = (response.cookies as { name: string; httpOnly?: boolean; sameSite?: string; path?: string }[]).find(
      (item) => item.name === LOGIN_COOKIE,
    );
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/api/auth" });
  });

  it("вход не настроен: сообщает об этом", async () => {
    const browser = new Browser(buildTestApp(db, null));
    const response = await browser.get(apiRoutes.telegramLoginStart.path);
    expect(response.headers.location).toBe("/?login_error=not_configured");
    expect(await browser.get(apiRoutes.me.path).then((r) => r.json())).toMatchObject({ status: "anonymous", loginAvailable: false });
  });
});

describe("удачный вход", () => {
  it("преподаватель: сессия с хэшами, обмен кода через Basic и PKCE, корректный ответ me", async () => {
    await makeTeacher(db, TEACHER);
    const browser = new Browser(app());
    const response = await loginWith(browser, oidc, (nonce) =>
      oidc.sign({ id: TEACHER, nonce, name: "Мария", preferred_username: "maria" }),
    );
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/");

    const request = oidc.state.lastRequest!;
    expect(request.authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
    expect(request.form.get("grant_type")).toBe("authorization_code");
    expect(request.form.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(request.form.get("client_id")).toBe(CLIENT_ID);

    const token = browser.cookies.get(SESSION_COOKIE)!;
    const [stored] = await db.select().from(webSessions);
    expect(stored?.tokenHash).not.toBe(token);
    expect(JSON.stringify(stored)).not.toContain(token);
    const days = (stored!.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);

    const me = await browser.refreshCsrf();
    expect(meResponse.parse(me)).toMatchObject({ status: "teacher", user: { telegramId: TEACHER, name: "Мария", username: "maria" } });
    expect(JSON.stringify(stored)).not.toContain(me.csrfToken);
    const [user] = await db.select().from(users).where(eq(users.telegramId, TEACHER));
    expect(user?.role).toBe("teacher");
  });

  it("флаги cookie: HttpOnly и SameSite=Lax; Secure только в production", async () => {
    await makeTeacher(db, TEACHER);
    const flags = async (isProduction: boolean) => {
      const browser = new Browser(buildTestApp(db, oidc, { isProduction }));
      const response = await loginWith(browser, oidc, (nonce) => oidc.sign({ id: TEACHER, nonce }));
      return (response.cookies as { name: string; httpOnly?: boolean; secure?: boolean; sameSite?: string; maxAge?: number; value: string }[]).filter(
        (cookie) => cookie.value !== "" && [SESSION_COOKIE, CSRF_COOKIE].includes(cookie.name),
      );
    };
    const dev = await flags(false);
    expect(dev).toHaveLength(2);
    for (const cookie of dev) {
      expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", maxAge: 30 * 24 * 60 * 60 });
      expect(cookie.secure).toBeFalsy();
    }
    for (const cookie of await flags(true)) expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax" });
  });
});

describe("без роли", () => {
  it.each([
    ["новый аккаунт", null],
    ["ученик", "student"],
  ] as const)("%s: нет доступа, показан Telegram ID, сессии нет, роль не выдана", async (_name, role) => {
    await makeUser(db, 7100, role);
    const browser = new Browser(app());
    const response = await loginWith(browser, oidc, (nonce) => oidc.sign({ id: 7100, nonce, name: "Гость" }));
    expect(response.headers.location).toBe("/");
    expect(await sessionCount()).toBe(0);
    expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
    expect((await browser.get(apiRoutes.me.path)).json()).toEqual({ status: "no_access", telegramId: 7100 });
    expect((await browser.get(apiRoutes.dashboard.path)).statusCode).toBe(401);
    expect((await browser.get(apiRoutes.listStudents.path)).statusCode).toBe(401);
    const [user] = await db.select().from(users).where(eq(users.telegramId, 7100));
    expect(user?.role).toBe(role);
  });

  it("неизвестный аккаунт создаётся без роли", async () => {
    const browser = new Browser(app());
    await loginWith(browser, oidc, (nonce) => oidc.sign({ id: 7101, nonce }));
    const [user] = await db.select().from(users).where(eq(users.telegramId, 7101));
    expect(user?.role).toBeNull();
  });
});

describe("отклонённые токены", () => {
  const rejected = async (build: (nonce: string) => Promise<string>, code = "failed") => {
    await makeTeacher(db, TEACHER);
    const browser = new Browser(app());
    const response = await loginWith(browser, oidc, build);
    expect(response.headers.location).toBe(`/?login_error=${code}`);
    expect(await sessionCount()).toBe(0);
    expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
    expect((await browser.get(apiRoutes.me.path)).json().status).toBe("anonymous");
  };

  it("подпись чужим ключом", () => rejected((nonce) => oidc.sign({ id: TEACHER, nonce }, { key: oidc.foreignKey })));
  it("неверный aud", () => rejected((nonce) => oidc.sign({ id: TEACHER, nonce }, { tweak: (t) => t.setAudience("999") })));
  it("aud клиента вместо ID бота", () => rejected((nonce) => oidc.sign({ id: TEACHER, nonce }, { tweak: (t) => t.setAudience(CLIENT_ID) })));
  it("неверный iss", () => rejected((nonce) => oidc.sign({ id: TEACHER, nonce }, { tweak: (t) => t.setIssuer("https://evil.example") })));
  it("просроченный токен", () => rejected((nonce) => oidc.sign({ id: TEACHER, nonce }, { tweak: (t) => t.setExpirationTime(Math.floor(Date.now() / 1000) - 60) })));
  it("неверный nonce", () => rejected(() => oidc.sign({ id: TEACHER, nonce: "другой" })));
  it("нет nonce", () => rejected(() => oidc.sign({ id: TEACHER })));
  it("нет claim id", () => rejected((nonce) => oidc.sign({ nonce })));
  it("id не число", () => rejected((nonce) => oidc.sign({ id: "abc", nonce })));
  it("токен без подписи (alg none)", () =>
    rejected(async (nonce) => new UnsecuredJWT({ id: TEACHER, nonce }).setIssuer("https://oauth.telegram.org").setAudience(BOT_ID).setExpirationTime("1h").encode()));
  it("мусор вместо токена", () => rejected(async () => "not.a.jwt"));

  it("нет exp", () => rejected((nonce) => oidc.sign({ id: TEACHER, nonce }, { noExpiry: true })));

  it("сбой конечной точки токена", async () => {
    oidc.state.tokenStatus = 500;
    await rejected((nonce) => oidc.sign({ id: TEACHER, nonce }));
  });
});

describe("state", () => {
  async function started(browser: Browser) {
    const start = await browser.get(apiRoutes.telegramLoginStart.path);
    const url = new URL(start.headers.location as string);
    oidc.state.expectedChallenge = url.searchParams.get("code_challenge");
    oidc.state.nextIdToken = await oidc.sign({ id: TEACHER, nonce: url.searchParams.get("nonce")! });
    return url.searchParams.get("state")!;
  }
  const callback = (browser: Browser, state: string) =>
    browser.get(`${apiRoutes.telegramLoginCallback.path}?code=abc&state=${state}`);

  beforeEach(() => makeTeacher(db, TEACHER));

  it("неверный state: токен не запрашивается, сессии нет", async () => {
    const browser = new Browser(app());
    await started(browser);
    oidc.state.lastRequest = null;
    const response = await callback(browser, "wrong");
    expect(response.headers.location).toBe("/?login_error=invalid_state");
    expect(oidc.state.lastRequest).toBeNull();
    expect(await sessionCount()).toBe(0);
  });

  it("нет cookie с параметрами входа", async () => {
    const browser = new Browser(app());
    const state = await started(browser);
    browser.cookies.delete(LOGIN_COOKIE);
    expect((await callback(browser, state)).headers.location).toBe("/?login_error=invalid_state");
  });

  it("подделанная cookie", async () => {
    const browser = new Browser(app());
    const state = await started(browser);
    const [payload, mac] = browser.cookies.get(LOGIN_COOKIE)!.split(".");
    browser.cookies.set(LOGIN_COOKIE, `${payload}x.${mac}`);
    expect((await callback(browser, state)).headers.location).toBe("/?login_error=invalid_state");
    expect(await sessionCount()).toBe(0);
  });

  it("cookie, собранная без секрета, не принимается", async () => {
    const browser = new Browser(app());
    await started(browser);
    const mac = browser.cookies.get(LOGIN_COOKIE)!.split(".")[1];
    const forged = { state: "attacker", nonce: "n", codeVerifier: "v", exp: Date.now() + 60_000 };
    browser.cookies.set(LOGIN_COOKIE, `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${mac}`);
    oidc.state.lastRequest = null;
    expect((await callback(browser, "attacker")).headers.location).toBe("/?login_error=invalid_state");
    expect(oidc.state.lastRequest).toBeNull();
  });

  it("экран «нет доступа» не показывает подделанный Telegram ID", async () => {
    const browser = new Browser(app());
    await loginWith(browser, oidc, (nonce) => oidc.sign({ id: 7100, nonce }));
    const mac = browser.cookies.get(NO_ACCESS_COOKIE)!.split(".")[1];
    const forged = { telegramId: 1, exp: Date.now() + 60_000 };
    browser.cookies.set(NO_ACCESS_COOKIE, `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${mac}`);
    expect((await browser.get(apiRoutes.me.path)).json().status).toBe("anonymous");
  });

  it("параметры входа одноразовые: повтор адреса возврата не работает", async () => {
    const browser = new Browser(app());
    const state = await started(browser);
    expect((await callback(browser, state)).headers.location).toBe("/");
    expect((await callback(browser, state)).headers.location).toBe("/?login_error=invalid_state");
    expect(await sessionCount()).toBe(1);
  });

  it("state чужого браузера не подходит", async () => {
    const instance = app();
    const victim = new Browser(instance);
    const attacker = new Browser(instance);
    await started(victim);
    const attackerState = await started(attacker);
    expect((await callback(victim, attackerState)).headers.location).toBe("/?login_error=invalid_state");
  });

  it("отказ пользователя в Telegram", async () => {
    const browser = new Browser(app());
    const state = await started(browser);
    const response = await browser.get(`${apiRoutes.telegramLoginCallback.path}?error=access_denied&state=${state}`);
    expect(response.headers.location).toBe("/?login_error=denied");
  });
});

describe("сессия и выход", () => {
  it("выход отзывает сессию на сервере: старая cookie больше не работает", async () => {
    await makeTeacher(db, TEACHER);
    const browser = await loginAs(new Browser(app()), oidc, TEACHER);
    const token = browser.cookies.get(SESSION_COOKIE)!;
    expect((await browser.send("POST", apiRoutes.logout.path)).statusCode).toBe(200);
    expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
    browser.cookies.set(SESSION_COOKIE, token);
    expect((await browser.get(apiRoutes.dashboard.path)).statusCode).toBe(401);
    expect((await db.select().from(webSessions))[0]?.revokedAt).toBeInstanceOf(Date);
  });

  it("выход без сессии безопасен, очищает экран «нет доступа»", async () => {
    const browser = new Browser(app());
    await loginWith(browser, oidc, (nonce) => oidc.sign({ id: 7100, nonce }));
    expect((await browser.send("POST", apiRoutes.logout.path)).statusCode).toBe(200);
    expect((await browser.get(apiRoutes.me.path)).json().status).toBe("anonymous");
  });

  it("истёкшая сессия не работает", async () => {
    await makeTeacher(db, TEACHER);
    const browser = await loginAs(new Browser(app()), oidc, TEACHER);
    await db.update(webSessions).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await browser.get(apiRoutes.dashboard.path)).statusCode).toBe(401);
    expect((await browser.get(apiRoutes.me.path)).json().status).toBe("anonymous");
  });

  it("выдуманная cookie не работает", async () => {
    const browser = new Browser(app());
    browser.cookies.set(SESSION_COOKIE, "x".repeat(43));
    expect((await browser.get(apiRoutes.dashboard.path)).statusCode).toBe(401);
  });

  it("снятая роль действует сразу, в том числе при уже открытой сессии", async () => {
    const teacher = await makeTeacher(db, TEACHER);
    const browser = await loginAs(new Browser(app()), oidc, TEACHER);
    await db.update(users).set({ role: null }).where(eq(users.id, teacher.id));
    const response = await browser.get(apiRoutes.dashboard.path);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("no_access");
    expect((await browser.get(apiRoutes.me.path)).json()).toEqual({ status: "no_access", telegramId: TEACHER });
  });

  it("снятие роли командой закрывает сессии", async () => {
    await makeTeacher(db, TEACHER);
    const browser = await loginAs(new Browser(app()), oidc, TEACHER);
    await removeTeacherRole(db, { telegramId: TEACHER, actor: "test" });
    expect((await browser.get(apiRoutes.dashboard.path)).statusCode).toBe(401);
  });
});

describe("CSRF", () => {
  async function logged() {
    await makeTeacher(db, TEACHER);
    return loginAs(new Browser(app()), oidc, TEACHER);
  }
  const payload = { displayName: "Пётр" };

  it("изменяющий запрос без заголовка отклоняется и ничего не делает", async () => {
    const browser = await logged();
    const response = await browser.request({ method: "POST", url: apiRoutes.createStudent.path, payload });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("csrf_failed");
    expect((await browser.get(apiRoutes.listStudents.path)).json().students).toEqual([]);
  });

  it("неверный токен отклоняется", async () => {
    const browser = await logged();
    const response = await browser.request({
      method: "POST",
      url: apiRoutes.createStudent.path,
      payload,
      headers: { [CSRF_HEADER]: "wrong" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("токен чужой сессии отклоняется, а сессионный токен CSRF не заменяет", async () => {
    await makeTeacher(db, TEACHER);
    await makeTeacher(db, TEACHER + 1);
    const instance = app();
    const a = await loginAs(new Browser(instance), oidc, TEACHER);
    const b = await loginAs(new Browser(instance), oidc, TEACHER + 1);
    for (const value of [b.csrfToken!, a.cookies.get(SESSION_COOKIE)!]) {
      const response = await a.request({ method: "POST", url: apiRoutes.createStudent.path, payload, headers: { [CSRF_HEADER]: value } });
      expect(response.statusCode).toBe(403);
    }
  });

  it("верный токен проходит; выход без токена отклонён", async () => {
    const browser = await logged();
    expect((await browser.send("POST", apiRoutes.createStudent.path, payload)).statusCode).toBe(200);
    expect((await browser.request({ method: "POST", url: apiRoutes.logout.path })).statusCode).toBe(403);
    expect((await browser.get(apiRoutes.dashboard.path)).statusCode).toBe(200);
  });

  it("если cookie токена потеряна, me выпускает новый, прежний перестаёт работать", async () => {
    const browser = await logged();
    const old = browser.csrfToken!;
    browser.cookies.delete(CSRF_COOKIE);
    await browser.refreshCsrf();
    expect(browser.csrfToken).not.toBe(old);
    expect((await browser.send("POST", apiRoutes.createStudent.path, payload)).statusCode).toBe(200);
    browser.csrfToken = old;
    expect((await browser.send("POST", apiRoutes.createStudent.path, payload)).statusCode).toBe(403);
  });
});

describe("ограничение частоты", () => {
  it("вход: после 20 запросов в минуту с адреса — 429 с Retry-After, другой адрес не затронут", async () => {
    const browser = new Browser(app());
    for (let i = 0; i < 20; i += 1) {
      expect((await browser.get(apiRoutes.telegramLoginStart.path)).statusCode).toBe(302);
    }
    const limited = await browser.get(apiRoutes.telegramLoginStart.path);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("rate_limited");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    const other = await browser.request({ method: "GET", url: apiRoutes.telegramLoginStart.path, remoteAddress: "10.0.0.9" });
    expect(other.statusCode).toBe(302);
  });

  it("за прокси подделка X-Forwarded-For лимит не обходит", async () => {
    const browser = new Browser(buildTestApp(db, oidc, {}, { proxyHops: 1 }));
    const call = (forwarded: string) =>
      browser.request({ method: "GET", url: apiRoutes.telegramLoginStart.path, headers: { "x-forwarded-for": forwarded } });
    // Прокси дописывает настоящий адрес последним; всё, что левее, прислал клиент.
    for (let i = 0; i < 20; i += 1) expect((await call(`1.2.3.${i}, 9.9.9.9`)).statusCode).toBe(302);
    expect((await call("5.5.5.5, 9.9.9.9")).statusCode).toBe(429);
    expect((await call("5.5.5.5, 8.8.8.8")).statusCode).toBe(302);
  });
});

describe("вход для разработки", () => {
  const DEV = 7200;
  const devApp = () => buildTestApp(db, null, { devLoginTelegramId: DEV });

  it("без переменной маршрута нет", async () => {
    const browser = new Browser(app());
    expect((await browser.get(apiRoutes.devLogin.path)).statusCode).toBe(404);
    expect((await browser.get(apiRoutes.me.path)).json().devLoginAvailable).toBe(false);
  });

  it("аккаунт без роли: роль не выдаётся, сессии нет, виден Telegram ID", async () => {
    const browser = new Browser(devApp());
    expect((await browser.get(apiRoutes.me.path)).json().devLoginAvailable).toBe(true);
    expect((await browser.get(apiRoutes.devLogin.path)).headers.location).toBe("/");
    const [user] = await db.select().from(users).where(eq(users.telegramId, DEV));
    expect(user?.role).toBeNull();
    expect(await sessionCount()).toBe(0);
    expect((await browser.get(apiRoutes.me.path)).json()).toEqual({ status: "no_access", telegramId: DEV });
  });

  it("преподаватель получает обычную сессию", async () => {
    await makeTeacher(db, DEV);
    const browser = new Browser(devApp());
    await browser.get(apiRoutes.devLogin.path);
    expect((await browser.refreshCsrf()).status).toBe("teacher");
    expect((await browser.get(apiRoutes.dashboard.path)).statusCode).toBe(200);
  });

  it("buildServer отказывается включать его в production", () => {
    expect(() => buildTestApp(db, null, { isProduction: true, devLoginTelegramId: DEV })).toThrow(/запрещён/);
  });

  it("настоящий запуск с NODE_ENV=production и DEV_LOGIN_TELEGRAM_ID завершается с ошибкой до любых запросов", async () => {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "production",
          DEV_LOGIN_TELEGRAM_ID: "42",
          BOT_TOKEN: "123:abc-DEF_1",
          DATABASE_URL: "postgres://nobody@127.0.0.1:1/none",
          APP_SECRET: "x".repeat(32),
          WEB_BASE_URL: "https://cabinet.example",
          TELEGRAM_LOGIN_CLIENT_ID: "id",
          TELEGRAM_LOGIN_CLIENT_SECRET: "secret",
        },
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.on("exit", (code) => resolve({ code, stderr }));
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("DEV_LOGIN_TELEGRAM_ID");
  });
});
