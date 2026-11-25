// Этап 7, критерий готовности: преподаватель видит только своих учеников, ученик — только свои материалы,
// а пилотная группа проходит полный цикл без ручного исправления данных.
// Два преподавателя и три ученика проходят весь путь через настоящие API кабинета и бота (заглушка только у Telegram).
// Подробные проверки каждого пункта раздела 8 плана лежат в профильных файлах; таблица соответствия — в отчёте этапа 7
// и в разделе 8 плана. Здесь — сквозной сценарий, где эти пункты встречаются вместе. Часы и случайность зафиксированы.
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DAILY_START, EXAM_START, START_HARD_ALL, startTest, startTranslate, wordsPage } from "../../src/bot/callback-data.js";
import { attempts, questions, sessions, studentLinks, users } from "../../src/db/schema.js";
import { createSeededRng } from "../../src/domain/learning/index.js";
import { runReminderTick } from "../../src/notifications/reminders.js";
import {
  apiRoutes,
  collectionResults,
  importPreviewResponse,
  importResponse,
  issueResponse,
  sourceCollectionDetail,
  studentResults,
  studentsResponse,
  type StudentResults,
} from "../../src/shared/api-contract.js";
import { createFakeOidc, type Browser, type FakeOidc } from "../helpers/api.js";
import { at, cardInput, connectedStudent, createCollection, createStudent, teacherSession } from "../helpers/cabinet.js";
import { openTestDb, resetDb } from "../helpers/db.js";
import { callbackUpdate, createFakeBot, sentTexts, textUpdate } from "../helpers/fake-telegram.js";
import { userId, type FakeBot } from "../helpers/learning.js";
import { getLink } from "../helpers/linking.js";
import { finishSession } from "../helpers/practice.js";

const { db, close } = openTestDb();
afterAll(close);
beforeEach(() => resetDb(db));

let oidc: FakeOidc;
beforeAll(async () => {
  oidc = await createFakeOidc();
});

const MARIA = 94001;
const BORIS = 94002;
const ANNA = 94101;
const VERA = 94102;
const GLEB = 94103;
// 24 ноября 2026, 19:00 по Москве: время напоминания по умолчанию.
const AT_SEVEN = new Date("2026-11-24T16:00:00Z");
const LATER = new Date("2026-11-24T16:30:00Z");

const learner = (seed: number) => createFakeBot(db, { now: () => LATER, rng: createSeededRng(seed) });
const press = (fake: FakeBot, telegramId: number, data: string) => fake.bot.handleUpdate(callbackUpdate(telegramId, data));

async function resultsOf(browser: Browser, studentId: number): Promise<StudentResults> {
  const response = await browser.get(at(apiRoutes.studentResults, studentId));
  expect(response.statusCode, response.body).toBe(200);
  return studentResults.parse(response.json());
}

/** Все слова, которые ученик видит в боте («Все слова», первая страница — словарь здесь короткий). */
async function wordsSeenInBot(fake: FakeBot, telegramId: number) {
  await press(fake, telegramId, wordsPage(0));
  return sentTexts(fake.calls).at(-1)!;
}

/** Инварианты данных, которые не должны требовать ручного исправления после пилота. */
async function expectConsistentData() {
  // Попытка с указанием связи относится к связи того же ученика, что и занятие. (Что после отвязки попытки к связи
  // не добавляются, проверяет сам сценарий: число попыток связи Веры не меняется.)
  const foreign = await db
    .select({ id: attempts.id })
    .from(attempts)
    .innerJoin(questions, eq(questions.id, attempts.questionId))
    .innerJoin(sessions, eq(sessions.id, questions.sessionId))
    .innerJoin(studentLinks, eq(studentLinks.id, attempts.studentLinkId))
    .where(
      and(
        isNotNull(attempts.studentLinkId),
        sql`${studentLinks.studentUserId} IS DISTINCT FROM ${sessions.studentUserId}`,
      ),
    );
  expect(foreign).toEqual([]);
  // Вторая попытка есть только после неверной первой.
  const orphanSecond = await db.execute(sql`
    SELECT a2.id FROM attempts a2
    LEFT JOIN attempts a1 ON a1.question_id = a2.question_id AND a1.attempt_number = 1
    WHERE a2.attempt_number = 2 AND (a1.id IS NULL OR a1.is_correct)`);
  expect(orphanSecond.rows).toEqual([]);
  // Завершённое занятие не оставляет открытых вопросов.
  const open = await db.execute(sql`
    SELECT q.id FROM questions q JOIN sessions s ON s.id = q.session_id
    WHERE s.status = 'completed' AND q.status <> 'closed'`);
  expect(open.rows).toEqual([]);
}

/** Сколько попыток в базе сделано в рамках связи: результаты должны строиться именно из них. */
async function attemptCount(linkId: number) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(attempts)
    .where(eq(attempts.studentLinkId, linkId));
  return row!.count;
}

const attemptsInResults = (results: StudentResults) =>
  results.answers.reduce((sum, answer) => sum + 1 + (answer.second ? 1 : 0), 0);

describe("пилот: два преподавателя, три ученика", () => {
  it("полный цикл: привязка, импорт, выдача, все режимы обучения, квест по расписанию, результаты, CSV, отвязка", async () => {
    const maria = await teacherSession(db, oidc, MARIA, "Мария");
    const boris = await teacherSession(db, oidc, BORIS, "Борис");

    // ---------- Привязка ----------
    const anna = await connectedStudent(db, maria.browser, ANNA, "Анна");
    const vera = await connectedStudent(db, maria.browser, VERA, "Вера");
    const gleb = await connectedStudent(db, boris.browser, GLEB, "Глеб");

    // Уже привязанная Анна открывает приглашение Бориса: отказ, запись Бориса ждёт подключения.
    const foreignInvite = await createStudent(boris.browser, "Не Анна");
    const annaBot = learner(11);
    await annaBot.bot.handleUpdate(textUpdate(ANNA, `/start ${foreignInvite.token}`));
    expect(sentTexts(annaBot.calls).at(-1)).toContain("прежний преподаватель должен сначала убрать");
    expect((await getLink(db, foreignInvite.id)).status).toBe("pending_connection");

    // Каждый видит в кабинете только своих учеников.
    const listOf = async (browser: Browser) =>
      studentsResponse.parse((await browser.get(apiRoutes.listStudents.path)).json()).students.map((s) => s.displayName).sort();
    expect(await listOf(maria.browser)).toEqual(["Анна", "Вера"]);
    expect(await listOf(boris.browser)).toEqual(["Глеб", "Не Анна"]);

    // ---------- Материалы: импорт с ошибками ничего не сохраняет до подтверждения ----------
    const pilot = await createCollection(maria.browser, "Пилот", []);
    const table = [
      "apple\tяблоко",
      "bank\tбанк",
      "bank\tберег",
      "cat\tкошка",
      "dog\tсобака",
      "без перевода",
      "apple\tяблоко",
      '"=HYPERLINK(""http://evil.example"")"\t+79990000000',
    ].join("\n");
    const preview = importPreviewResponse.parse(
      (await maria.browser.send("POST", at(apiRoutes.importPreview, pilot.id), { text: table })).json(),
    );
    expect(preview).toMatchObject({ toAdd: 6, invalid: 1, duplicates: 1 });
    expect(sourceCollectionDetail.parse((await maria.browser.get(at(apiRoutes.getCollection, pilot.id))).json()).cards).toEqual([]);
    const imported = importResponse.parse((await maria.browser.send("POST", at(apiRoutes.importCards, pilot.id), { text: table })).json());
    expect(imported).toMatchObject({ added: 6, skippedInvalid: 1, skippedDuplicates: 1 });

    // Выдача двум ученикам одним действием: независимые копии.
    const issued = issueResponse.parse((await maria.browser.send("POST", at(apiRoutes.issueCollection, pilot.id), { studentIds: [anna.id, vera.id] })).json());
    const [annaCopy, veraCopy] = issued.results.map((result) => result.copyId) as [number, number];
    const borisCollection = await createCollection(boris.browser, "Подборка Бориса", [
      cardInput("sun", "солнце"),
      cardInput("moon", "луна"),
      cardInput("star", "звезда"),
    ]);
    const glebCopy = issueResponse.parse((await boris.browser.send("POST", at(apiRoutes.issueCollection, borisCollection.id), { studentIds: [gleb.id] })).json())
      .results[0]!.copyId;

    // Ученик видит только свои материалы.
    const veraBot = learner(12);
    const glebBot = learner(13);
    expect(await wordsSeenInBot(annaBot, ANNA)).toContain("apple");
    expect(await wordsSeenInBot(annaBot, ANNA)).not.toContain("sun");
    expect(await wordsSeenInBot(glebBot, GLEB)).toContain("sun");
    expect(await wordsSeenInBot(glebBot, GLEB)).not.toContain("apple");

    // ---------- Обучение ----------
    for (const telegramId of [ANNA, VERA, GLEB]) {
      await db.update(users).set({ timezone: "Europe/Moscow" }).where(eq(users.telegramId, telegramId));
    }
    // Анна: тест (apple дважды неверно — сложное), практика сложных слов, «Переведи меня».
    await press(annaBot, ANNA, startTest(annaCopy));
    await finishSession(db, annaBot, ANNA, (english) => english !== "apple");
    await press(annaBot, ANNA, START_HARD_ALL);
    await finishSession(db, annaBot, ANNA);
    await press(annaBot, ANNA, startTranslate(annaCopy));
    await finishSession(db, annaBot, ANNA, (english, attempt) => english !== "cat" || attempt === 2);
    // Вера: тест без ошибок, экзамен.
    await press(veraBot, VERA, startTest(veraCopy));
    await finishSession(db, veraBot, VERA);
    await press(veraBot, VERA, EXAM_START);
    await finishSession(db, veraBot, VERA, (english) => english !== "dog");
    // Глеб: тест у Бориса.
    await press(glebBot, GLEB, startTest(glebCopy));
    await finishSession(db, glebBot, GLEB, (english) => english !== "moon");

    // Планировщик в 19:00: по квесту каждому, повторный такт ничего не добавляет. Анна проходит квест.
    expect(await runReminderTick(db, { now: AT_SEVEN, rng: createSeededRng(1) })).toMatchObject({ questsCreated: 3, reminded: 3 });
    expect(await runReminderTick(db, { now: AT_SEVEN, rng: createSeededRng(1) })).toMatchObject({ questsCreated: 0, reminded: 0 });
    await press(annaBot, ANNA, DAILY_START);
    await finishSession(db, annaBot, ANNA);

    // ---------- Результаты ----------
    const annaResults = await resultsOf(maria.browser, anna.id);
    expect(annaResults.sessions.map((session) => session.type).sort()).toEqual(["daily_quest", "hard_words", "test", "translate"]);
    expect(annaResults.sessions.find((session) => session.type === "daily_quest")).toMatchObject({ status: "completed", questLocalDate: "2026-11-24" });
    expect(annaResults.progress).toMatchObject({ questsCompleted: 1, questStreak: 1, totalCollections: 1 });
    // «bank — банк» и «bank — берег» — два слова.
    expect(annaResults.words.filter((word) => word.english === "bank")).toHaveLength(2);
    // Результаты построены из сохранённых попыток этой связи — ровно из них.
    expect(attemptsInResults(annaResults)).toBe(await attemptCount(anna.id));
    const veraResults = await resultsOf(maria.browser, vera.id);
    // Квест планировщика создан на паузе: Вера его ещё не начинала, он виден как «на паузе» без ответов.
    expect(veraResults.sessions.map((session) => session.type).sort()).toEqual(["daily_quest", "exam", "test"]);
    expect(veraResults.sessions.find((session) => session.type === "daily_quest")).toMatchObject({ status: "paused", answeredCount: 0 });
    expect(attemptsInResults(veraResults)).toBe(await attemptCount(vera.id));
    const glebResults = await resultsOf(boris.browser, gleb.id);
    expect(glebResults.answers.map((answer) => answer.english)).not.toContain("apple");
    expect(attemptsInResults(glebResults)).toBe(await attemptCount(gleb.id));

    // По подборке: двое получили и завершили, apple — самое трудное слово.
    const byCollection = collectionResults.parse((await maria.browser.get(at(apiRoutes.collectionResults, pilot.id))).json());
    expect(byCollection.recipients.map((recipient) => [recipient.displayName, recipient.status])).toEqual([
      ["Анна", "completed"],
      ["Вера", "completed"],
    ]);
    expect(byCollection.words[0]).toMatchObject({ english: "apple", becameHard: 1 });

    // Чужой преподаватель не видит ни одного результата Марии и наоборот.
    for (const url of [
      at(apiRoutes.getStudent, anna.id),
      at(apiRoutes.studentResults, anna.id),
      at(apiRoutes.studentResultsCsv, vera.id),
      at(apiRoutes.collectionResults, pilot.id),
      at(apiRoutes.getCopy, annaCopy),
    ]) {
      expect((await boris.browser.get(url)).statusCode, url).toBe(404);
    }
    for (const url of [at(apiRoutes.studentResults, gleb.id), at(apiRoutes.studentResultsCsv, gleb.id), at(apiRoutes.collectionResults, borisCollection.id)]) {
      expect((await maria.browser.get(url)).statusCode, url).toBe(404);
    }
    expect((await boris.browser.get(apiRoutes.dashboard.path)).body).not.toMatch(/Анна|Вера|Пилот/);

    // CSV: формула из карточки не исполняется.
    const csv = (await maria.browser.get(at(apiRoutes.studentResultsCsv, anna.id))).body;
    expect(csv).toContain(`'=HYPERLINK(""http://evil.example"")`);
    expect(csv).toContain("'+79990000000");
    expect(csv).not.toMatch(/(^|;|\r\n)[=+@]/);

    // ---------- Отвязка ----------
    expect((await maria.browser.send("POST", at(apiRoutes.unlinkStudent, vera.id))).statusCode).toBe(200);
    expect((await maria.browser.get(at(apiRoutes.studentResults, vera.id))).statusCode).toBe(404);
    expect(await listOf(maria.browser)).toEqual(["Анна"]);
    // Вера занимается по своей копии дальше, но новых материалов не получает.
    await press(veraBot, VERA, startTranslate(veraCopy));
    await finishSession(db, veraBot, VERA);
    const lateIssue = await maria.browser.send("POST", at(apiRoutes.issueCollection, pilot.id), { studentIds: [vera.id] });
    expect(lateIssue.statusCode).toBe(404);
    const afterUnlink = collectionResults.parse((await maria.browser.get(at(apiRoutes.collectionResults, pilot.id))).json());
    expect(afterUnlink.recipients.map((recipient) => recipient.displayName)).toEqual(["Анна"]);
    // Ответы после отвязки ни к одной связи не относятся.
    const veraUser = await userId(db, VERA);
    const unlinkedAttempts = await db.execute(sql`
      SELECT count(*)::int AS n FROM attempts a JOIN questions q ON q.id = a.question_id JOIN sessions s ON s.id = q.session_id
      WHERE s.student_user_id = ${veraUser} AND s.type = 'translate'`);
    expect(Number(unlinkedAttempts.rows[0]!.n)).toBeGreaterThan(0);
    expect(await attemptCount(vera.id)).toBe(attemptsInResults(veraResults));

    await expectConsistentData();
  });
});
