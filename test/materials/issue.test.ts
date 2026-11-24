// Этап 4: выдача подборки нескольким ученикам и уведомления о ней.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { notifications, studentCards, studentCollections, users } from "../../src/db/schema.js";
import { renderNotification } from "../../src/notifications/render.js";
import { apiRoutes, copyDetail, issuePreviewResponse, issueResponse } from "../../src/shared/api-contract.js";
import { createFakeOidc, type FakeOidc } from "../helpers/api.js";
import {
  at,
  cardInput,
  connectedStudent,
  createCollection,
  createStudent,
  issueTo,
  requestingStudent,
  teacherSession,
} from "../helpers/cabinet.js";
import { openTestDb, resetDb } from "../helpers/db.js";
import { callbackUpdate, createFakeBot, sentTexts } from "../helpers/fake-telegram.js";
import { collectionsPage } from "../../src/bot/callback-data.js";

const { db, close } = openTestDb();
afterAll(close);
beforeEach(() => resetDb(db));

let oidc: FakeOidc;
beforeAll(async () => {
  oidc = await createFakeOidc();
});

const TEACHER = 92001;
const OTHER_TEACHER = 92002;
const ACTIVE = 92101;
const REQUESTING = 92102;

const userIdOf = async (telegramId: number) => (await db.select().from(users).where(eq(users.telegramId, telegramId)))[0]!.id;
const newCollectionNotices = async () =>
  (await db.select().from(notifications).where(eq(notifications.reason, "new_collection"))).map((row) => ({
    recipient: row.recipientUserId,
    payload: row.payload,
  }));

/** Три ученика в разных состояниях и подборка из трёх карточек. */
async function setup() {
  const { browser, teacher } = await teacherSession(db, oidc, TEACHER);
  const active = await connectedStudent(db, browser, ACTIVE, "Анна");
  const waiting = await createStudent(browser, "Борис");
  const requesting = await requestingStudent(db, browser, REQUESTING, "Вера");
  const collection = await createCollection(browser, "Еда", [cardInput("bread", "хлеб"), cardInput("milk", "молоко"), cardInput("tea", "чай")]);
  return { browser, teacher, active, waiting, requesting, collection };
}

describe("выдача", () => {
  it("предпросмотр: кому и какое уведомление придёт; ничего не меняется", async () => {
    const { browser, active, waiting, requesting, collection } = await setup();
    const response = await browser.send("POST", at(apiRoutes.issuePreview, collection.id), {
      studentIds: [active.id, waiting.id, requesting.id],
    });
    expect(response.statusCode, response.body).toBe(200);
    const message = renderNotification("new_collection", { title: "Еда", wordCount: 3 });
    expect(issuePreviewResponse.parse(response.json()).recipients).toEqual([
      { studentId: active.id, displayName: "Анна", status: "active", outcome: "now", message },
      { studentId: waiting.id, displayName: "Борис", status: "pending_connection", outcome: "after_connection", message },
      { studentId: requesting.id, displayName: "Вера", status: "pending_confirmation", outcome: "after_connection", message },
    ]);
    expect(message).toContain("Слов: 3");
    expect(await db.select().from(studentCollections)).toHaveLength(0);
    expect(await newCollectionNotices()).toEqual([]);
  });

  it("трём ученикам одним запросом: независимые копии, уведомление только подключённому; повтор не дублирует", async () => {
    const { browser, active, waiting, requesting, collection } = await setup();
    const ids = [active.id, waiting.id, requesting.id];
    const first = issueResponse.parse((await issueTo(browser, collection.id, ids)).json());
    expect(first.results.map((r) => [r.studentId, r.outcome])).toEqual([
      [active.id, "now"],
      [waiting.id, "after_connection"],
      [requesting.id, "after_connection"],
    ]);
    const copies = await db.select().from(studentCollections);
    expect(copies).toHaveLength(3);
    expect(new Set(copies.map((copy) => copy.id)).size).toBe(3);
    expect(await db.select().from(studentCards)).toHaveLength(9);
    expect(await newCollectionNotices()).toEqual([
      { recipient: await userIdOf(ACTIVE), payload: { studentCollectionId: first.results[0]!.copyId, title: "Еда", wordCount: 3 } },
    ]);
    // У заявителя слова не заведены: материалы откроются после подтверждения.
    const requestingCopy = copies.find((copy) => copy.studentLinkId === requesting.id)!;
    expect((await db.select().from(studentCards).where(eq(studentCards.studentCollectionId, requestingCopy.id))).every((c) => c.studentWordId === null)).toBe(true);

    const again = issueResponse.parse((await issueTo(browser, collection.id, [...ids, active.id])).json());
    expect(again.results.map((r) => r.outcome)).toEqual(["already_issued", "already_issued", "already_issued"]);
    expect(again.results.map((r) => r.copyId)).toEqual(first.results.map((r) => r.copyId));
    expect(await db.select().from(studentCollections)).toHaveLength(3);
    expect(await newCollectionNotices()).toHaveLength(1);

    const preview = issuePreviewResponse.parse((await browser.send("POST", at(apiRoutes.issuePreview, collection.id), { studentIds: ids })).json());
    expect(preview.recipients.map((r) => [r.outcome, r.message])).toEqual([
      ["already_issued", null],
      ["already_issued", null],
      ["already_issued", null],
    ]);
  });

  it("одновременные одинаковые запросы дают одну копию и одно уведомление", async () => {
    const { browser, active, collection } = await setup();
    const responses = await Promise.all([1, 2, 3].map(() => issueTo(browser, collection.id, [active.id])));
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(responses.map((r) => r.json().results[0].outcome).sort()).toEqual(["already_issued", "already_issued", "now"]);
    expect(await db.select().from(studentCollections)).toHaveLength(1);
    expect(await newCollectionNotices()).toHaveLength(1);
  });

  it("неподключённому: копия хранится, «Новая подборка» приходит после подтверждения связи, один раз", async () => {
    const { browser, requesting, collection } = await setup();
    await issueTo(browser, collection.id, [requesting.id]);
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(REQUESTING, collectionsPage(0)));
    expect(sentTexts(fake.calls).at(-1)).not.toContain("Еда");
    expect(await newCollectionNotices()).toEqual([]);

    expect((await browser.send("POST", at(apiRoutes.approveRequest, requesting.id), { code: requesting.code })).statusCode).toBe(200);
    expect(await newCollectionNotices()).toEqual([
      { recipient: await userIdOf(REQUESTING), payload: expect.objectContaining({ title: "Еда", wordCount: 3 }) },
    ]);
    await fake.bot.handleUpdate(callbackUpdate(REQUESTING, collectionsPage(0)));
    expect(sentTexts(fake.calls).at(-1)).toContain("Еда");
    // Повтор после подтверждения — уже выдана, второго уведомления нет.
    expect((await issueTo(browser, collection.id, [requesting.id])).json().results[0].outcome).toBe("already_issued");
    expect(await newCollectionNotices()).toHaveLength(1);
  });

  it("после отвязки выдача запрещена: 404, никому из запроса ничего не выдано", async () => {
    const { browser, active, waiting, collection } = await setup();
    expect((await browser.send("POST", at(apiRoutes.unlinkStudent, active.id))).statusCode).toBe(200);
    for (const route of [apiRoutes.issueCollection, apiRoutes.issuePreview]) {
      const response = await browser.send("POST", at(route, collection.id), { studentIds: [waiting.id, active.id] });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("not_found");
    }
    expect(await db.select().from(studentCollections)).toHaveLength(0);
  });

  it("чужой ученик в списке и чужая подборка: 404 без подробностей", async () => {
    const { browser, active, collection } = await setup();
    const other = await teacherSession(db, oidc, OTHER_TEACHER, "Борис");
    const foreignStudent = await createStudent(other.browser, "Чужой");
    const foreignCollection = await createCollection(other.browser, "Чужая", [cardInput("cat", "кот")]);

    const mixed = await issueTo(browser, collection.id, [active.id, foreignStudent.id]);
    expect(mixed.statusCode).toBe(404);
    expect(mixed.body).not.toContain("Чужой");
    expect((await issueTo(browser, foreignCollection.id, [active.id])).statusCode).toBe(404);
    expect((await issueTo(other.browser, collection.id, [foreignStudent.id])).statusCode).toBe(404);
    expect(await db.select().from(studentCollections)).toHaveLength(0);
  });

  it("пустой или слишком длинный список учеников: 400", async () => {
    const { browser, collection } = await setup();
    expect((await issueTo(browser, collection.id, [])).statusCode).toBe(400);
    expect((await issueTo(browser, collection.id, Array.from({ length: 101 }, (_, i) => i + 1))).statusCode).toBe(400);
  });
});

describe("условие готовности этапа 4", () => {
  it("преподаватель сам создаёт подборку и выдаёт её; изменение одной копии не затрагивает другую, правка оригинала — обе", async () => {
    const { browser } = await teacherSession(db, oidc, TEACHER);
    const anna = await connectedStudent(db, browser, ACTIVE, "Анна");
    const vera = await connectedStudent(db, browser, REQUESTING, "Вера");
    const collection = await createCollection(browser, "Еда", [cardInput("bread", "хлеб"), cardInput("milk", "молоко")]);
    const { results } = issueResponse.parse((await issueTo(browser, collection.id, [anna.id, vera.id])).json());
    const [annaCopy, veraCopy] = results.map((r) => r.copyId) as [number, number];

    const copyOf = async (id: number) => copyDetail.parse((await browser.get(at(apiRoutes.getCopy, id))).json());
    const before = await copyOf(veraCopy);
    const bread = (await copyOf(annaCopy)).cards.find((c) => c.english === "bread")!;
    const edited = await browser.send("PATCH", at(apiRoutes.editCopyCard, bread.id), cardInput("bread", "хлеб", { example: "Fresh bread." }));
    expect(edited.statusCode, edited.body).toBe(200);
    await browser.send("POST", at(apiRoutes.addCopyCards, annaCopy), { cards: [cardInput("tea", "чай")] });
    await browser.send("PATCH", at(apiRoutes.editSourceCard, collection.cards[1]!.id), cardInput("milk", "молочко"));

    expect(await copyOf(veraCopy)).toEqual(before);
    const anna2 = await copyOf(annaCopy);
    expect(anna2.cards.map((c) => [c.english, c.translation, c.example, c.versionNumber])).toEqual([
      ["bread", "хлеб", "Fresh bread.", 2],
      ["milk", "молоко", null, 1],
      ["tea", "чай", null, 1],
    ]);

    // Ученики видят каждый своё.
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(ACTIVE, collectionsPage(0)));
    expect(sentTexts(fake.calls).at(-1)).toContain("Еда");
  });
});
