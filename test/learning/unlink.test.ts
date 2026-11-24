// После отвязки ученик занимается по своим копиям, заявитель материалов не видит, связи разделены.
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NEW_CODE, collectionFromNotification, collectionPage, collectionsPage, startTest, wordCard, wordsPage } from "../../src/bot/callback-data.js";
import { issueCollectionCopy } from "../../src/db/collections.js";
import { loadFixtureCollections } from "../../src/db/fixtures.js";
import { attempts, cardViews, notifications, sessions, sourceCollections, studentCollections, studentLinks } from "../../src/db/schema.js";
import { IssueError, issueFixtureCollection } from "../../src/learning/issue.js";
import { deliverDueNotifications } from "../../src/notifications/worker.js";
import { openTestDb, resetDb } from "../helpers/db.js";
import { callbackUpdate, createFakeBot, lastButtons, sentTexts, textUpdate } from "../helpers/fake-telegram.js";
import {
  answer,
  card,
  cardByEnglish,
  collectionStatus,
  connectStudent,
  issue,
  wordByPair,
  words,
} from "../helpers/learning.js";
import { joinThroughBot, linkingFor, makeTeacher, reasons } from "../helpers/linking.js";

const { db, close } = openTestDb();
afterAll(close);
beforeEach(() => resetDb(db));

const STUDENT = 74001;
const linking = linkingFor(db);
const noSleep = async () => {};

async function newRequest(teacherId: number, fake: ReturnType<typeof createFakeBot>, telegramId = STUDENT) {
  const created = await linking.createStudent({ teacherUserId: teacherId, displayName: "Заявитель" });
  const code = await joinThroughBot(fake, telegramId, created.invitation.token);
  return { linkId: created.linkId, code };
}

describe("после отвязки", () => {
  it("меню и материалы доступны, занятие начинается и пишет связь null, прогресс сохраняется", async () => {
    const { teacher, link, student } = await connectStudent(db, STUDENT);
    const id = await issue(db, link.id, "Подборка", words(3));
    await linking.unlinkStudent({ teacherUserId: teacher.id, linkId: link.id });
    const fake = createFakeBot(db);

    await fake.bot.handleUpdate(textUpdate(STUDENT, "/start"));
    expect(sentTexts(fake.calls).at(-1)).toContain("Преподаватель больше не ведёт ваши занятия");
    expect(sentTexts(fake.calls).at(-1)).toContain("новых материалов не будет");
    expect(lastButtons(fake.calls).map((button) => button.text)).toContain("Подборки");

    await fake.bot.handleUpdate(callbackUpdate(STUDENT, collectionsPage(0)));
    expect(sentTexts(fake.calls).at(-1)).toContain("Подборка");
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, collectionPage(id, 0)));
    const word = await wordByPair(db, student.id, "word1", "слово-word-1");
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, wordCard(word.id, 0)));
    expect(sentTexts(fake.calls).at(-1)).toContain("word1 — слово-word-1");
    expect((await db.select().from(cardViews)).every((view) => view.studentLinkId === null)).toBe(true);

    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(id)));
    await answer(fake, db, STUDENT, false);
    const [session] = await db.select().from(sessions);
    expect(session?.studentLinkId).toBeNull();
    const [attempt] = await db.select().from(attempts);
    expect(attempt?.studentLinkId).toBeNull();
    expect(await collectionStatus(db, id)).toBe("practicing");
  });

  it("занятие, начатое при связи, продолжается: занятие хранит связь начала, попытка после отвязки пишет null", async () => {
    const { teacher, link } = await connectStudent(db, STUDENT);
    const id = await issue(db, link.id, "Подборка", words(4));
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(id)));
    await answer(fake, db, STUDENT, true);
    await linking.unlinkStudent({ teacherUserId: teacher.id, linkId: link.id });
    await answer(fake, db, STUDENT, true);
    const rows = await db.select().from(attempts).orderBy(attempts.id);
    expect(rows.map((row) => row.studentLinkId)).toEqual([link.id, null]);
    expect((await db.select().from(sessions))[0]?.studentLinkId).toBe(link.id);
  });

  it("новые материалы не приходят: выдача отклонена, копии и уведомления нет", async () => {
    const { teacher, link, student } = await connectStudent(db, STUDENT);
    await issue(db, link.id, "Подборка", words(3));
    await linking.unlinkStudent({ teacherUserId: teacher.id, linkId: link.id });
    const before = await reasons(db, student.id);
    await expect(
      issueFixtureCollection(db, { studentLinkId: link.id, title: "Новая", fixtures: [{ title: "Новая", cards: words(2) }] }),
    ).rejects.toBeInstanceOf(IssueError);
    expect(await db.select().from(studentCollections)).toHaveLength(1);
    expect(await reasons(db, student.id)).toEqual(before);
  });

  it("копия не создаётся и прямым вызовом выдачи по завершённой связи", async () => {
    const { teacher, link } = await connectStudent(db, STUDENT);
    const [source] = await db.insert(sourceCollections).values({ teacherUserId: teacher.id, title: "Новая" }).returning();
    await linking.unlinkStudent({ teacherUserId: teacher.id, linkId: link.id });
    await expect(issueCollectionCopy(db, { studentLinkId: link.id, sourceCollectionId: source!.id })).rejects.toThrow("завершена");
    expect(await db.select().from(studentCollections)).toHaveLength(0);
  });

  it("без копий: понятное сообщение вместо меню", async () => {
    const { teacher, link } = await connectStudent(db, STUDENT);
    await linking.unlinkStudent({ teacherUserId: teacher.id, linkId: link.id });
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(textUpdate(STUDENT, "/start"));
    expect(sentTexts(fake.calls).at(-1)).toBe(
      "Преподаватель больше не ведёт ваши занятия, а выданных материалов у вас нет. " +
        "Чтобы заниматься снова, попросите у преподавателя персональную ссылку и откройте её.",
    );
    expect(lastButtons(fake.calls)).toEqual([]);
  });
});

describe("заявитель без подтверждения", () => {
  it("копия заявки не видна ни в меню, ни прямой кнопкой", async () => {
    const teacher = await makeTeacher(db, 74100);
    const fake = createFakeBot(db);
    const { linkId, code } = await newRequest(teacher.id, fake);
    const id = await issue(db, linkId, "Подборка", words(3));

    for (const data of [collectionsPage(0), wordsPage(0), collectionPage(id, 0), collectionFromNotification(id), startTest(id)]) {
      await fake.bot.handleUpdate(callbackUpdate(STUDENT, data));
      expect(sentTexts(fake.calls).at(-1)).toContain("ждёт подтверждения");
    }
    expect(await db.select().from(sessions)).toHaveLength(0);

    // После подтверждения всё открывается, и уведомление ведёт к подборке.
    await linking.approveRequest({ teacherUserId: teacher.id, linkId, code });
    const [notification] = await db.select().from(notifications).where(eq(notifications.reason, "new_collection"));
    expect(notification?.payload).toMatchObject({ studentCollectionId: id, title: "Подборка", wordCount: 3 });
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, collectionFromNotification(id)));
    expect(sentTexts(fake.calls).at(-1)).toContain("Подборка\nОпубликована:");
  });

  it("бывший ученик с заявкой: прежние копии открыты, новые нет, код можно перевыпустить", async () => {
    const { teacher: oldTeacher, link: oldLink } = await connectStudent(db, STUDENT);
    const oldId = await issue(db, oldLink.id, "Прежняя", words(2, "old"));
    await linking.unlinkStudent({ teacherUserId: oldTeacher.id, linkId: oldLink.id });

    const teacher = await makeTeacher(db, 74101);
    const fake = createFakeBot(db);
    const { linkId } = await newRequest(teacher.id, fake);
    const newId = await issue(db, linkId, "Новая", words(2, "new"));

    await fake.bot.handleUpdate(textUpdate(STUDENT, "/start"));
    expect(sentTexts(fake.calls).at(-1)).toContain("ждёт подтверждения");
    const labels = lastButtons(fake.calls).map((button) => button.text);
    expect(labels).toEqual(expect.arrayContaining(["Подборки", "Новый код"]));

    await fake.bot.handleUpdate(callbackUpdate(STUDENT, collectionsPage(0)));
    expect(sentTexts(fake.calls).at(-1)).toContain("Прежняя");
    expect(sentTexts(fake.calls).at(-1)).not.toContain("Новая");
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, collectionPage(newId, 0)));
    expect(fake.calls.at(-1)?.payload.text).toBe("Подборка не найдена.");
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, collectionPage(oldId, 0)));
    expect(sentTexts(fake.calls).at(-1)).toContain("Прежняя");

    await fake.bot.handleUpdate(callbackUpdate(STUDENT, NEW_CODE));
    expect(sentTexts(fake.calls).at(-1)).toContain("Ваш проверочный код");
  });

  it("отклонение: заявитель сразу получает сообщение без подробностей, один раз", async () => {
    const teacher = await makeTeacher(db, 74100);
    const fake = createFakeBot(db);
    const { linkId } = await newRequest(teacher.id, fake);
    await linking.rejectRequest({ teacherUserId: teacher.id, linkId });

    const rows = await db.select().from(notifications).where(eq(notifications.reason, "request_rejected"));
    expect(rows).toHaveLength(1);
    await deliverDueNotifications(db, fake.bot.api, { sleep: noSleep });
    await deliverDueNotifications(db, fake.bot.api, { sleep: noSleep });
    const text = fake.calls.filter((call) => call.method === "sendMessage").map((call) => call.payload.text as string);
    const rejected = text.filter((item) => item.includes("отклонил"));
    expect(rejected).toEqual(["Преподаватель отклонил заявку. Если это ошибка, попросите у него новую ссылку."]);
    expect(rejected[0]).not.toContain("Заявитель");
    expect(rows[0]?.payload).toEqual({});
  });
});

describe("новая связь", () => {
  it("попытка по копии прежней связи не пишет новую связь; статус новой копии не раскрывает старые ответы", async () => {
    const { teacher, link, student } = await connectStudent(db, STUDENT);
    const oldId = await issue(db, link.id, "Прежняя", [card("fast", "быстрый"), card("slow", "медленный")]);
    const fake = createFakeBot(db);
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(oldId)));
    await answer(fake, db, STUDENT, true);
    await answer(fake, db, STUDENT, true);
    expect(await collectionStatus(db, oldId)).toBe("completed");
    await linking.unlinkStudent({ teacherUserId: teacher.id, linkId: link.id });

    // Вернулся к тому же преподавателю: новая запись.
    const { linkId, code } = await newRequest(teacher.id, fake);
    await linking.approveRequest({ teacherUserId: teacher.id, linkId, code });
    const newId = await issue(db, linkId, "Новая", [card("fast", "быстрый"), card("red", "красный")]);

    // Слово общее, но ответы прежней связи в статус новой копии не входят.
    const fresh = await cardByEnglish(db, newId, "fast");
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, wordCard(fresh.card.studentWordId!, 0)));
    expect(await collectionStatus(db, newId)).toBe("started");

    // Слово есть в обеих копиях: просмотр прежней копии без связи, новой со связью.
    const viewed = await db.select().from(cardViews).where(eq(cardViews.studentCardId, fresh.card.id));
    expect(viewed.map((view) => view.studentLinkId)).toEqual([linkId]);
    const oldCard = await cardByEnglish(db, oldId, "fast");
    const viewedOld = await db.select().from(cardViews).where(eq(cardViews.studentCardId, oldCard.card.id));
    expect(viewedOld.map((view) => view.studentLinkId)).toEqual([null]);

    // Занятие по копии прежней связи при активной новой: связь пустая.
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(oldId)));
    const oldSession = (await db.select().from(sessions).where(eq(sessions.status, "current")))[0]!;
    expect(oldSession.studentLinkId).toBeNull();
    await answer(fake, db, STUDENT, true);
    const lastOld = (await db.select().from(attempts).orderBy(attempts.id)).at(-1)!;
    expect(lastOld.studentLinkId).toBeNull();
    expect(await collectionStatus(db, newId)).toBe("started");

    // Занятие по новой копии: пишется новая связь, статус считается только по её ответам.
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, startTest(newId)));
    const newSession = (await db.select().from(sessions).where(eq(sessions.status, "current")))[0]!;
    expect(newSession.studentLinkId).toBe(linkId);
    await answer(fake, db, STUDENT, true);
    const lastNew = (await db.select().from(attempts).orderBy(attempts.id)).at(-1)!;
    expect(lastNew.studentLinkId).toBe(linkId);
    expect(await collectionStatus(db, newId)).toBe("practicing");
    const links = await db.select().from(studentLinks).where(eq(studentLinks.studentUserId, student.id));
    expect(links).toHaveLength(2);
    expect(await wordByPair(db, student.id, "fast", "быстрый")).toBeTruthy();
  });
});

describe("служебная выдача", () => {
  it("запись без подключения: копия хранится, уведомление уходит после подтверждения, повтор не дублирует", async () => {
    const teacher = await makeTeacher(db, 74100);
    const created = await linking.createStudent({ teacherUserId: teacher.id, displayName: "Новый" });
    const fixtures = await loadFixtureCollections();
    const first = await issueFixtureCollection(db, { studentLinkId: created.linkId, title: "Базовые слова", fixtures });
    expect(first).toMatchObject({ created: true, notification: "after_confirmation" });
    const again = await issueFixtureCollection(db, { studentLinkId: created.linkId, title: "Базовые слова", fixtures });
    expect(again).toEqual({ ...first, created: false });
    expect(await db.select().from(notifications)).toHaveLength(0);

    const fake = createFakeBot(db);
    const code = await joinThroughBot(fake, STUDENT, created.invitation.token);
    // Заявка есть, но материалов и уведомления о них всё ещё нет.
    const pending = await issueFixtureCollection(db, { studentLinkId: created.linkId, title: "Путешествие", fixtures });
    expect(pending.notification).toBe("after_confirmation");
    expect((await db.select().from(notifications)).filter((row) => row.reason === "new_collection")).toHaveLength(0);

    await linking.approveRequest({ teacherUserId: teacher.id, linkId: created.linkId, code });
    const queued = (await db.select().from(notifications)).filter((row) => row.reason === "new_collection");
    expect(queued).toHaveLength(2);

    await fake.bot.handleUpdate(textUpdate(STUDENT, "/start"));
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, collectionPage(first.studentCollectionId, 0)));
    expect(sentTexts(fake.calls).at(-1)).toContain("breakfast — завтрак");
  });

  it("активная связь: уведомление с кнопкой «Посмотреть» сразу, повторная выдача не дублирует его", async () => {
    const { link, student } = await connectStudent(db, STUDENT);
    const fixtures = await loadFixtureCollections();
    const result = await issueFixtureCollection(db, { studentLinkId: link.id, title: "Глаголы и to", fixtures });
    expect(result.notification).toBe("queued");
    await issueFixtureCollection(db, { studentLinkId: link.id, title: "Глаголы и to", fixtures });
    expect(await reasons(db, student.id)).toEqual(["new_collection"]);

    const fake = createFakeBot(db);
    await deliverDueNotifications(db, fake.bot.api, { sleep: noSleep });
    const sent = fake.calls.find((call) => call.method === "sendMessage")!;
    expect(sent.payload.text).toContain("Новая подборка: Глаголы и to. Слов: 10.");
    expect(sent.payload.text).toContain("начните практику");
    const button = sent.payload.reply_markup.inline_keyboard.flat()[0];
    expect(button).toEqual({ text: "Посмотреть", callback_data: collectionFromNotification(result.studentCollectionId) });
    await fake.bot.handleUpdate(callbackUpdate(STUDENT, button.callback_data));
    expect(sentTexts(fake.calls).at(-1)).toContain("Глаголы и to");
  });

  it("неизвестное название и несуществующая запись: понятная ошибка", async () => {
    const { link } = await connectStudent(db, STUDENT);
    const fixtures = await loadFixtureCollections();
    await expect(issueFixtureCollection(db, { studentLinkId: link.id, title: "Нет такой", fixtures })).rejects.toThrow(
      /нет подборки «Нет такой».*Базовые слова/,
    );
    await expect(issueFixtureCollection(db, { studentLinkId: 999999, title: "Базовые слова", fixtures })).rejects.toThrow(
      "не найдена",
    );
  });
});
