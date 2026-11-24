// Кабинет через настоящий HTTP API: преподаватель входит, создаёт учеников и материалы.
import { expect } from "vitest";
import type { Db } from "../../src/db/client.js";
import {
  apiRoutes,
  createStudentResponse,
  sourceCollectionDetail,
  type CardInput,
} from "../../src/shared/api-contract.js";
import { Browser, buildTestApp, loginAs, type FakeOidc } from "./api.js";
import { createFakeBot } from "./fake-telegram.js";
import { joinThroughBot, makeTeacher } from "./linking.js";

type Route = { path: string };

/** Адрес маршрута с подставленным :id. */
export const at = (route: Route, id: number | string) => route.path.replace(":id", String(id));

export async function teacherSession(db: Db, oidc: FakeOidc, telegramId: number, name = "Мария") {
  const teacher = await makeTeacher(db, telegramId, name);
  const app = buildTestApp(db, oidc);
  return { teacher, app, browser: await loginAs(new Browser(app), oidc, telegramId) };
}

export async function createStudent(browser: Browser, displayName = "Пётр") {
  const response = await browser.send("POST", apiRoutes.createStudent.path, { displayName });
  expect(response.statusCode).toBe(200);
  const body = createStudentResponse.parse(response.json());
  return { id: body.student.id, token: new URL(body.invitation.url).searchParams.get("start")! };
}

/** Ученик подтвердил присоединение, код ещё не введён: «Ожидает подтверждения». */
export async function requestingStudent(db: Db, browser: Browser, telegramId: number, displayName = "Заявитель") {
  const created = await createStudent(browser, displayName);
  const fake = createFakeBot(db);
  const code = await joinThroughBot(fake, telegramId, created.token);
  return { ...created, code, fake };
}

/** Подключение через бота и ввод кода в кабинете. */
export async function connectedStudent(db: Db, browser: Browser, telegramId: number, displayName = "Анна") {
  const requesting = await requestingStudent(db, browser, telegramId, displayName);
  const response = await browser.send("POST", at(apiRoutes.approveRequest, requesting.id), { code: requesting.code });
  expect(response.statusCode).toBe(200);
  return requesting;
}

export const cardInput = (english: string, translation: string, extra: Partial<CardInput> = {}): CardInput => ({
  english,
  translation,
  ...extra,
});

/** Подборка с карточками через API. */
export async function createCollection(browser: Browser, title: string, cards: CardInput[]) {
  const created = await browser.send("POST", apiRoutes.createCollection.path, { title });
  expect(created.statusCode, created.body).toBe(200);
  const id = sourceCollectionDetail.parse(created.json()).id;
  for (const card of cards) {
    const response = await browser.send("POST", at(apiRoutes.addCollectionCard, id), card);
    expect(response.statusCode, response.body).toBe(200);
  }
  const detail = await browser.get(at(apiRoutes.getCollection, id));
  return sourceCollectionDetail.parse(detail.json());
}

export async function issueTo(browser: Browser, collectionId: number, studentIds: number[]) {
  return browser.send("POST", at(apiRoutes.issueCollection, collectionId), { studentIds });
}
