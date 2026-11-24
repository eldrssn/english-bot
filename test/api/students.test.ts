import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { issueCollectionCopy } from "../../src/db/collections.js";
import {
  cardVersions,
  invitations,
  notifications,
  sessions,
  sourceCards,
  sourceCollections,
  studentCards,
  studentCollections,
  studentLinks,
  studentWords,
  users,
} from "../../src/db/schema.js";
import { CSRF_HEADER, apiRoutes, createStudentResponse, dashboardResponse, studentDetail, studentsResponse } from "../../src/shared/api-contract.js";
import { Browser, buildTestApp, createFakeOidc, loginAs, type FakeOidc } from "../helpers/api.js";
import { openTestDb, resetDb } from "../helpers/db.js";
import { callbackUpdate, createFakeBot, sentTexts, textUpdate } from "../helpers/fake-telegram.js";
import { getLink, joinThroughBot, makeTeacher, seededCollectionId } from "../helpers/linking.js";

const { db, close } = openTestDb();
afterAll(close);
beforeEach(() => resetDb(db));

let oidc: FakeOidc;
beforeAll(async () => {
  oidc = await createFakeOidc();
});

const TEACHER_A = 7001;
const TEACHER_B = 7002;
const STUDENT = 6001;

async function twoTeachers() {
  const teacherA = await makeTeacher(db, TEACHER_A, "Мария");
  const teacherB = await makeTeacher(db, TEACHER_B, "Борис");
  const app = buildTestApp(db, oidc);
  return {
    app,
    teacherA,
    teacherB,
    a: await loginAs(new Browser(app), oidc, TEACHER_A),
    b: await loginAs(new Browser(app), oidc, TEACHER_B),
  };
}

const studentPath = (id: number, suffix = "") => `/api/students/${id}${suffix}`;

async function createStudent(browser: Browser, displayName = "Пётр") {
  const response = await browser.send("POST", apiRoutes.createStudent.path, { displayName });
  expect(response.statusCode).toBe(200);
  const body = createStudentResponse.parse(response.json());
  const token = new URL(body.invitation.url).searchParams.get("start")!;
  return { id: body.student.id, token, body };
}

/** Доводит запись до активной связи через настоящего бота и API. */
async function connect(browser: Browser, telegramId = STUDENT) {
  const created = await createStudent(browser);
  const fake = createFakeBot(db);
  const code = await joinThroughBot(fake, telegramId, created.token);
  const response = await browser.send("POST", studentPath(created.id, "/request/approve"), { code });
  expect(response.statusCode).toBe(200);
  return { ...created, fake };
}

describe("условие готовности этапа 2: один преподаватель подключает ученика, другой не видит связь", () => {
  it("полный путь", async () => {
    const { a, b, teacherA } = await twoTeachers();

    // Создание: ссылка один раз, в формате бота, без имени ученика.
    const created = await createStudent(a, "Пётр Иванов");
    expect(created.body.invitation.url).toMatch(/^https:\/\/t\.me\/test_bot\?start=[A-Za-z0-9_-]{1,64}$/);
    expect(created.body.invitation.url).not.toContain("Пётр");
    expect(created.body.student).toMatchObject({ status: "pending_connection", pendingAction: "wait_for_student", telegramName: null });
    expect(created.body.student.invitation.live).toBe(true);
    // Токен не отдаётся повторно.
    expect(JSON.stringify((await a.get(studentPath(created.id))).json())).not.toContain(created.token);

    // Ученик подтвердил: заявка и уведомление преподавателю, материалы закрыты.
    const fake = createFakeBot(db);
    const code = await joinThroughBot(fake, STUDENT, created.token);
    const dashboard = dashboardResponse.parse((await a.get(apiRoutes.dashboard.path)).json());
    expect(dashboard).toMatchObject({ studentCount: 1, activeStudentCount: 0 });
    expect(dashboard.pendingRequests).toHaveLength(1);
    expect(dashboard.pendingRequests[0]).toMatchObject({ studentId: created.id, displayName: "Пётр Иванов", telegramName: "Анна", telegramUsername: "anna" });
    const [notice] = await db.select().from(notifications).where(eq(notifications.recipientUserId, teacherA.id));
    expect(notice?.reason).toBe("join_request");

    const request = (await a.get(studentPath(created.id, "/request"))).json().request;
    expect(request).toMatchObject({ telegramId: STUDENT, telegramName: "Анна", telegramUsername: "anna", codeState: "active", attemptsLeft: 5 });

    // Другой преподаватель ничего не видит.
    expect((await b.get(apiRoutes.listStudents.path)).json().students).toEqual([]);
    expect(dashboardResponse.parse((await b.get(apiRoutes.dashboard.path)).json())).toEqual({ studentCount: 0, activeStudentCount: 0, pendingRequests: [] });
    expect((await b.send("POST", studentPath(created.id, "/request/approve"), { code })).statusCode).toBe(404);

    // Неверный код: попытка засчитана.
    const wrong = code === "000000" ? "000001" : "000000";
    const failed = await a.send("POST", studentPath(created.id, "/request/approve"), { code: wrong });
    expect(failed.statusCode).toBe(422);
    expect(failed.json().error).toMatchObject({ code: "wrong_code", attemptsLeft: 4 });

    // Верный код: подключён.
    const approved = await a.send("POST", studentPath(created.id, "/request/approve"), { code });
    expect(approved.statusCode).toBe(200);
    expect(studentDetail.parse(approved.json())).toMatchObject({ status: "active", telegramName: "Анна", pendingAction: null, request: null });

    await fake.bot.handleUpdate(textUpdate(STUDENT, "/start"));
    expect(sentTexts(fake.calls).at(-1)).toContain("Выберите раздел");

    // И после подключения другой не видит.
    expect((await b.get(apiRoutes.listStudents.path)).json().students).toEqual([]);
    expect((await b.get(studentPath(created.id))).statusCode).toBe(404);
    const list = studentsResponse.parse((await a.get(apiRoutes.listStudents.path)).json());
    expect(list.students.map((student) => student.id)).toEqual([created.id]);
  });
});

describe("проверка данных и коды ошибок", () => {
  it("пустое имя и слишком длинное имя — 400; имя обрезается", async () => {
    const { a } = await twoTeachers();
    for (const displayName of ["", "   ", "x".repeat(101)]) {
      const response = await a.send("POST", apiRoutes.createStudent.path, { displayName });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("bad_request");
    }
    expect((await a.send("POST", apiRoutes.createStudent.path, { displayName: "  Анна  " })).json().student.displayName).toBe("Анна");
  });

  it("код не из 6 цифр — 400 и попытка не тратится", async () => {
    const { a } = await twoTeachers();
    const created = await createStudent(a);
    await joinThroughBot(createFakeBot(db), STUDENT, created.token);
    for (const code of ["12345", "1234567", "abcdef", ""]) {
      expect((await a.send("POST", studentPath(created.id, "/request/approve"), { code })).statusCode).toBe(400);
    }
    const [invitation] = await db.select().from(invitations);
    expect(invitation?.codeAttempts).toBe(0);
  });

  it("битый JSON — 400 в общем формате", async () => {
    const { a } = await twoTeachers();
    const response = await a.request({
      method: "POST",
      url: apiRoutes.createStudent.path,
      payload: "{not json",
      headers: { "content-type": "application/json", "x-csrf-token": a.csrfToken! },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("bad_request");
  });

  it("неизвестный путь /api — JSON 404", async () => {
    const { a } = await twoTeachers();
    const response = await a.get("/api/unknown");
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("not_found");
  });

  it("пять неверных кодов: code_inactive; ученик берёт новый в боте, подключение проходит", async () => {
    const { a } = await twoTeachers();
    const created = await createStudent(a);
    const fake = createFakeBot(db);
    const code = await joinThroughBot(fake, STUDENT, created.token);
    const wrong = code === "000000" ? "000001" : "000000";
    const statuses: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await a.send("POST", studentPath(created.id, "/request/approve"), { code: wrong })).json().error.code);
    }
    expect(statuses).toEqual(["wrong_code", "wrong_code", "wrong_code", "wrong_code", "code_inactive", "code_inactive"]);
    const blocked = await a.send("POST", studentPath(created.id, "/request/approve"), { code });
    expect(blocked.json().error.code).toBe("code_inactive");
    expect((await a.get(studentPath(created.id, "/request"))).json().request).toMatchObject({ codeState: "inactive", attemptsLeft: 0 });

    await fake.bot.handleUpdate(callbackUpdate(STUDENT, "code:new"));
    const fresh = sentTexts(fake.calls).at(-1)!.match(/\b\d{6}\b/)![0];
    expect((await a.send("POST", studentPath(created.id, "/request/approve"), { code: fresh })).statusCode).toBe(200);
  });

  it("ограничение частоты на ввод кода: 11-й запрос за минуту — 429", async () => {
    const { a } = await twoTeachers();
    const created = await createStudent(a);
    await joinThroughBot(createFakeBot(db), STUDENT, created.token);
    for (let i = 0; i < 10; i += 1) {
      const response = await a.send("POST", studentPath(created.id, "/request/approve"), { code: "000000" });
      expect(response.statusCode).not.toBe(429);
    }
    const limited = await a.send("POST", studentPath(created.id, "/request/approve"), { code: "000000" });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeTruthy();
  });

  it("ссылка: новая, отмена, конфликты", async () => {
    const { a } = await twoTeachers();
    const created = await createStudent(a);
    const reissued = await a.send("POST", studentPath(created.id, "/invitation"));
    expect(reissued.statusCode).toBe(200);
    expect(reissued.json().url).not.toContain(created.token);

    const revoked = await a.send("DELETE", studentPath(created.id, "/invitation"));
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ pendingAction: "send_link", invitation: { live: false, lastOutcome: "revoked" } });
    const again = await a.send("DELETE", studentPath(created.id, "/invitation"));
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("no_live_invitation");
  });

  it("отклонение: запись снова ждёт, аккаунта нет, причина видна", async () => {
    const { a } = await twoTeachers();
    const created = await createStudent(a);
    await joinThroughBot(createFakeBot(db), STUDENT, created.token);
    const response = await a.send("POST", studentPath(created.id, "/request/reject"));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "pending_connection",
      telegramName: null,
      pendingAction: "send_link",
      request: null,
      invitation: { live: false, lastOutcome: "rejected" },
    });
    expect((await a.get(studentPath(created.id, "/request"))).json()).toEqual({ request: null });
    const conflict = await a.send("POST", studentPath(created.id, "/request/reject"));
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("no_request");
  });

  it("при заявке новая ссылка и отвязка возвращают request_pending", async () => {
    const { a } = await twoTeachers();
    const created = await createStudent(a);
    await joinThroughBot(createFakeBot(db), STUDENT, created.token);
    expect((await a.send("POST", studentPath(created.id, "/invitation"))).json().error.code).toBe("request_pending");
    expect((await a.send("POST", studentPath(created.id, "/unlink"))).json().error.code).toBe("request_pending");
  });
});

describe("сквозные сценарии раздела 8", () => {
  it("переименование: привязка и история не изменились", async () => {
    const { a } = await twoTeachers();
    const { id } = await connect(a);
    const before = await getLink(db, id);
    const renamed = await a.send("PATCH", studentPath(id), { displayName: "Новое имя" });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ displayName: "Новое имя", status: "active", telegramName: "Анна" });
    const after = await getLink(db, id);
    expect(after).toMatchObject({ status: "active", studentUserId: before.studentUserId, startedAt: before.startedAt });
  });

  it("отвязка: доступ преподавателя исчез, запись не показывается, ученик уведомлён и не потерял аккаунт", async () => {
    const { a } = await twoTeachers();
    const { id, fake } = await connect(a);
    expect((await a.send("POST", studentPath(id, "/unlink"))).json()).toEqual({ ok: true });

    expect((await a.get(apiRoutes.listStudents.path)).json().students).toEqual([]);
    for (const [method, suffix] of [["GET", ""], ["GET", "/request"], ["POST", "/unlink"], ["POST", "/invitation"], ["DELETE", "/invitation"]] as const) {
      const response = await a.request({ method, url: studentPath(id, suffix), headers: { "x-csrf-token": a.csrfToken! } });
      expect(response.statusCode).toBe(404);
    }
    const [student] = await db.select().from(users).where(eq(users.telegramId, STUDENT));
    expect(student?.role).toBe("student");
    const queued = await db.select().from(notifications).where(eq(notifications.recipientUserId, student!.id));
    expect(queued.map((row) => row.reason)).toContain("link_ended");

    await fake.bot.handleUpdate(textUpdate(STUDENT, "/start"));
    expect(sentTexts(fake.calls).at(-1)).toContain("персональную ссылку");
  });

  it("ученик вернулся к прежнему преподавателю: виден только новый период", async () => {
    const { a } = await twoTeachers();
    const first = await connect(a);
    const { collectionId } = await seededCollectionId(db);
    await issueCollectionCopy(db, { studentLinkId: first.id, sourceCollectionId: collectionId });
    const [student] = await db.select().from(users).where(eq(users.telegramId, STUDENT));
    await db.insert(sessions).values({ studentUserId: student!.id, studentLinkId: first.id, type: "test", status: "completed" });
    expect((await a.get(studentPath(first.id))).json().collections).toHaveLength(1);
    expect((await a.get(studentPath(first.id))).json().lastActivityAt).not.toBeNull();

    await a.send("POST", studentPath(first.id, "/unlink"));
    const second = await connect(a);
    expect(second.id).not.toBe(first.id);

    const list = studentsResponse.parse((await a.get(apiRoutes.listStudents.path)).json());
    expect(list.students.map((item) => item.id)).toEqual([second.id]);
    const detail = (await a.get(studentPath(second.id))).json();
    expect(detail.collections).toEqual([]);
    expect(detail.lastActivityAt).toBeNull();
    expect((await a.get(studentPath(first.id))).statusCode).toBe(404);
  });

  it("выданная до подключения подборка видна в карточке со статусом записи", async () => {
    const { a } = await twoTeachers();
    const created = await createStudent(a);
    const { collectionId } = await seededCollectionId(db);
    await issueCollectionCopy(db, { studentLinkId: created.id, sourceCollectionId: collectionId });
    const detail = (await a.get(studentPath(created.id))).json();
    expect(detail.status).toBe("pending_connection");
    expect(detail.collections).toHaveLength(1);
    expect(detail.collections[0].wordCount).toBeGreaterThan(0);
  });

  it("срок заявки истёк: запись снова ждёт, заявка исчезла с главной", async () => {
    const { a } = await twoTeachers();
    const created = await createStudent(a);
    await joinThroughBot(createFakeBot(db), STUDENT, created.token);
    await db.update(invitations).set({ requestExpiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.studentLinkId, created.id));
    expect((await a.get(apiRoutes.dashboard.path)).json().pendingRequests).toEqual([]);
    expect((await a.get(studentPath(created.id))).json()).toMatchObject({
      status: "pending_connection",
      telegramName: null,
      invitation: { lastOutcome: "expired" },
    });
  });
});

// ---------- Перебор маршрутов ----------

type ContractRoute = (typeof apiRoutes)[keyof typeof apiRoutes];
const contractRoutes: ContractRoute[] = Object.values(apiRoutes);
const contractOf = (method: string, url: string) => contractRoutes.find((route) => route.method === method && route.path === url);

const card = { english: "hack", translation: "взлом" };
/** Верные тела: чужой запрос не должен пройти и с ними. Маршрут с телом без образца роняет тест. */
const samplePayload = (url: string, method: string, studentId = 1) => {
  if (method === "GET" || method === "HEAD") return undefined;
  const route = contractOf(method, url);
  if (!route || !("body" in route)) return undefined;
  switch (route) {
    case apiRoutes.approveRequest:
      return { code: "123456" };
    case apiRoutes.createStudent:
    case apiRoutes.renameStudent:
      return { displayName: "Взлом" };
    case apiRoutes.createCollection:
    case apiRoutes.renameCollection:
      return { title: "Взлом" };
    case apiRoutes.addCollectionCard:
    case apiRoutes.editSourceCard:
    case apiRoutes.editCopyCard:
      return card;
    case apiRoutes.addCopyCards:
      return { cards: [card] };
    case apiRoutes.reorderCollectionCards:
      return { cardIds: [] };
    case apiRoutes.importPreview:
    case apiRoutes.importCards:
      return { text: "hack\tвзлом" };
    case apiRoutes.issuePreview:
    case apiRoutes.issueCollection:
      return { studentIds: [studentId] };
    default:
      throw new Error(`Нет образца тела для ${method} ${url}`);
  }
};

const apiRouteTable = (app: FastifyInstance) => app.registeredRoutes.filter((route) => route.url.startsWith("/api/"));

type ObjectAccess = "own-student" | "own-collection" | "own-source-card" | "own-copy" | "own-copy-card";
const accessOf = (method: string, url: string): ObjectAccess => {
  const route = contractOf(method === "HEAD" ? "GET" : method, url);
  if (!route) throw new Error(`Маршрута ${method} ${url} нет в контракте`);
  if (route.access === "public" || route.access === "teacher") throw new Error(`У ${url} есть :id, но доступ ${route.access}`);
  return route.access;
};

/**
 * Объекты преподавателя А всех видов доступа, через настоящий API: записи учеников в каждом состоянии,
 * исходная подборка с карточкой, копии (у подключённого и неподключённого) с карточками.
 */
async function materialsOf(a: Browser) {
  const waiting = await createStudent(a, "Тайное имя 1");
  const requesting = await createStudent(a, "Тайное имя 2");
  await joinThroughBot(createFakeBot(db), STUDENT + 1, requesting.token);
  const connected = await connect(a, STUDENT + 2);

  const collection = (await a.send("POST", apiRoutes.createCollection.path, { title: "Тайная подборка" })).json();
  const sourceCard = (await a.send("POST", apiRoutes.addCollectionCard.path.replace(":id", String(collection.id)), { english: "secret", translation: "Тайное слово" })).json().card;
  const issued = (await a.send("POST", apiRoutes.issueCollection.path.replace(":id", String(collection.id)), { studentIds: [connected.id, waiting.id] })).json();
  const copyIds: number[] = issued.results.map((result: { copyId: number }) => result.copyId);
  const copyCardIds = (await db.select().from(studentCards)).map((row) => row.id);
  expect(copyIds).toHaveLength(2);
  expect(copyCardIds).toHaveLength(2);

  const ids: Record<ObjectAccess, number[]> = {
    "own-student": [waiting.id, requesting.id, connected.id],
    "own-collection": [collection.id],
    "own-source-card": [sourceCard.id],
    "own-copy": copyIds,
    "own-copy-card": copyCardIds,
  };
  return { ids, connected };
}

const snapshotAll = async () => ({
  links: await db.select().from(studentLinks).orderBy(studentLinks.id),
  invitations: await db.select().from(invitations).orderBy(invitations.id),
  notifications: await db.select().from(notifications).orderBy(notifications.id),
  sourceCollections: await db.select().from(sourceCollections).orderBy(sourceCollections.id),
  sourceCards: await db.select().from(sourceCards).orderBy(sourceCards.id),
  studentCollections: await db.select().from(studentCollections).orderBy(studentCollections.id),
  studentCards: await db.select().from(studentCards).orderBy(studentCards.id),
  cardVersions: await db.select().from(cardVersions).orderBy(cardVersions.id),
  studentWords: await db.select().from(studentWords).orderBy(studentWords.id),
  sessions: await db.select().from(sessions).orderBy(sessions.id),
});

describe("перебор всех маршрутов API", () => {
  it("контракт не зависит от сервера: единственный импорт — zod", async () => {
    const source = await readFile("src/shared/api-contract.ts", "utf8");
    expect([...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1])).toEqual(["zod"]);
  });

  it("каждый объявленный маршрут есть в контракте и наоборот", async () => {
    const app = buildTestApp(db, oidc, { devLoginTelegramId: 1 });
    await app.ready();
    const actual = new Set(apiRouteTable(app).filter((route) => route.method !== "HEAD").map((route) => `${route.method} ${route.url}`));
    const expected = new Set(contractRoutes.map((route) => `${route.method} ${route.path}`));
    expect(actual).toEqual(expected);
  });

  it("ни один непубличный маршрут не работает без сессии", async () => {
    const app = buildTestApp(db, oidc);
    await app.ready();
    const publicPaths = new Set<string>(contractRoutes.filter((route) => route.access === "public").map((route) => route.path));
    const routes = apiRouteTable(app).filter((route) => !publicPaths.has(route.url));
    expect(routes.length).toBeGreaterThan(10);
    const browser = new Browser(app);
    for (const route of routes) {
      const response = await browser.request({ method: route.method, url: route.url.replace(":id", "1") });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
    }
  });

  it("чужой преподаватель получает 404 на каждом маршруте с :id, данные не меняются и не утекают", async () => {
    const { app, a, b } = await twoTeachers();
    await app.ready();
    const { ids } = await materialsOf(a);
    // У Б есть свой ученик: тело выдачи с ним верное, отказать должна проверка подборки.
    const ownOfB = await createStudent(b, "Ученик Б");
    const before = await snapshotAll();

    const routes = apiRouteTable(app).filter((route) => route.url.includes(":id"));
    expect(routes.length).toBeGreaterThanOrEqual(24);
    const covered = new Set<ObjectAccess>();

    for (const route of routes) {
      const access = accessOf(route.method, route.url);
      covered.add(access);
      for (const id of ids[access]) {
        const payload = samplePayload(route.url, route.method, ownOfB.id);
        const response = await b.send(route.method, route.url.replace(":id", String(id)), payload);
        const label = `${route.method} ${route.url} для ${access} ${id}`;
        expect(response.statusCode, label).toBe(404);
        if (route.method !== "HEAD") {
          expect(response.json().error.code, label).toBe("not_found");
          expect(response.body, label).not.toMatch(/Тайн/);
        }
        // Неверное тело: права проверяются раньше данных, ответ тот же.
        if (payload !== undefined) {
          const invalid = await b.send(route.method, route.url.replace(":id", String(id)), { bogus: true });
          expect(invalid.statusCode, `${label}, неверное тело`).toBe(404);
        }
      }
    }
    expect([...covered].sort()).toEqual(["own-collection", "own-copy", "own-copy-card", "own-source-card", "own-student"]);
    expect(await snapshotAll()).toEqual(before);
  });

  it("свой преподаватель проходит проверку прав на каждом GET с :id: образцы объектов настоящие", async () => {
    const { app, a } = await twoTeachers();
    await app.ready();
    const { ids } = await materialsOf(a);
    for (const route of apiRouteTable(app).filter((r) => r.url.includes(":id") && r.method === "GET")) {
      for (const id of ids[accessOf(route.method, route.url)]) {
        const response = await a.get(route.url.replace(":id", String(id)));
        expect(response.statusCode, `${route.url} ${id}`).toBe(200);
      }
    }
  });

  it("ни один изменяющий маршрут преподавателя не работает без CSRF: 403 и ничего не меняется", async () => {
    const { app, a } = await twoTeachers();
    await app.ready();
    const { ids, connected } = await materialsOf(a);
    const before = await snapshotAll();
    const routes = contractRoutes.filter((route) => route.access !== "public" && route.method !== "GET");
    expect(routes.length).toBeGreaterThanOrEqual(22);
    for (const route of routes) {
      const id = route.path.includes(":id") ? ids[route.access as ObjectAccess][0]! : null;
      const url = id === null ? route.path : route.path.replace(":id", String(id));
      const payload = samplePayload(route.path, route.method, connected.id);
      for (const headers of [{}, { [CSRF_HEADER]: "wrong" }] as Record<string, string>[]) {
        const response = await a.request({ method: route.method, url, ...(payload === undefined ? {} : { payload }), headers });
        expect(response.statusCode, `${route.method} ${url}`).toBe(403);
        expect(response.json().error.code).toBe("csrf_failed");
      }
    }
    expect(await snapshotAll()).toEqual(before);
  });

  it("чужие, несуществующие, удалённые и забранные объекты неотличимы; битый ID тоже 404", async () => {
    const { app, a, b } = await twoTeachers();
    await app.ready();
    const foreign = await materialsOf(a);
    const ended = await createStudent(a);
    await a.send("POST", studentPath(ended.id, "/unlink"));

    // Свои, но недоступные объекты каждого вида.
    const collection = (await a.send("POST", apiRoutes.createCollection.path, { title: "Удаляемая" })).json();
    const deletedCard = (await a.send("POST", `/api/collections/${collection.id}/cards`, { english: "gone", translation: "нет" })).json().card;
    await a.send("POST", `/api/collections/${collection.id}/cards`, { english: "kept", translation: "есть" });
    const studentToUnlink = await createStudent(a, "Будет отвязан");
    const issued = (await a.send("POST", `/api/collections/${collection.id}/issue`, { studentIds: [foreign.connected.id, studentToUnlink.id] })).json();
    const [withdrawnCopy, endedCopy] = issued.results.map((r: { copyId: number }) => r.copyId) as [number, number];
    const copyCards = (await a.get(`/api/copies/${withdrawnCopy}`)).json().cards as { id: number }[];
    const [deletedCopyCard, cardOfWithdrawn] = copyCards.map((c) => c.id) as [number, number];
    await a.send("DELETE", `/api/copy-cards/${deletedCopyCard}`);
    await a.send("DELETE", `/api/source-cards/${deletedCard.id}`);
    await a.send("DELETE", `/api/copies/${withdrawnCopy}`);
    const endedCopyCard = ((await a.get(`/api/copies/${endedCopy}`)).json().cards as { id: number }[])[0]!.id;
    await a.send("POST", studentPath(studentToUnlink.id, "/unlink"));
    const deletedCollection = (await a.send("POST", apiRoutes.createCollection.path, { title: "Удалена" })).json();
    await a.send("DELETE", `/api/collections/${deletedCollection.id}`);

    const gone: Record<ObjectAccess, number[]> = {
      "own-student": [ended.id],
      "own-collection": [deletedCollection.id],
      "own-source-card": [deletedCard.id],
      "own-copy": [withdrawnCopy, endedCopy],
      "own-copy-card": [deletedCopyCard, cardOfWithdrawn, endedCopyCard],
    };
    const routes = apiRouteTable(app).filter((route) => route.url.includes(":id") && route.method !== "HEAD");
    for (const route of routes) {
      const access = accessOf(route.method, route.url);
      const payload = samplePayload(route.url, route.method, foreign.connected.id);
      const call = (browser: Browser, id: string | number) => browser.send(route.method, route.url.replace(":id", String(id)), payload);
      const foreignResponse = await call(b, foreign.ids[access][0]!);
      expect(foreignResponse.statusCode, route.url).toBe(404);
      expect((await call(a, 999999)).body).toBe(foreignResponse.body);
      for (const id of gone[access]) {
        expect((await call(a, id)).body, `${route.method} ${route.url} ${access} ${id}`).toBe(foreignResponse.body);
      }
      for (const bad of ["abc", "0", "-1", "1e3", "99999999999999999999", "1;DROP"]) {
        expect((await call(a, encodeURIComponent(bad))).statusCode, `${route.url} ${bad}`).toBe(404);
      }
    }
  });

  it("чужой получает 404 и при неверном теле: проверка прав идёт раньше проверки данных", async () => {
    const { app, a, b } = await twoTeachers();
    await app.ready();
    const created = await createStudent(a);
    expect((await b.send("PATCH", studentPath(created.id), { displayName: "" })).statusCode).toBe(404);
    expect((await b.send("POST", studentPath(created.id, "/request/approve"), { code: "x" })).statusCode).toBe(404);
  });

  it("у маршрутов без :id данные только свои", async () => {
    const { a, b } = await twoTeachers();
    await createStudent(a, "Только мой");
    const [listB, dashboardB] = [await b.get(apiRoutes.listStudents.path), await b.get(apiRoutes.dashboard.path)];
    expect(listB.body).not.toContain("Только мой");
    expect(dashboardB.json()).toMatchObject({ studentCount: 0 });
    expect((await a.get(apiRoutes.listStudents.path)).json().students).toHaveLength(1);
  });
});
