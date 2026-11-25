// Этап 7: страницы результатов и выгрузка CSV. Ученик занимается через настоящего бота (заглушка только у Telegram),
// преподаватель смотрит результаты через настоящий API. Часы и случайность зафиксированы.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DAILY_START, EXAM_START, collectionCard, startTest, startTranslate } from "../../src/bot/callback-data.js";
import { studentCards, studentCollections, users } from "../../src/db/schema.js";
import { createSeededRng } from "../../src/domain/learning/index.js";
import { CSV_BOM, csvCell, csvDocument, formatCsvDate } from "../../src/results/csv.js";
import {
  apiRoutes,
  collectionResults,
  dashboardResponse,
  studentResults,
  type StudentResults,
} from "../../src/shared/api-contract.js";
import { createFakeOidc, type Browser, type FakeOidc } from "../helpers/api.js";
import { at, cardInput, connectedStudent, createCollection, createStudent, issueTo, teacherSession } from "../helpers/cabinet.js";
import { openTestDb, resetDb } from "../helpers/db.js";
import { callbackUpdate, createFakeBot, textUpdate } from "../helpers/fake-telegram.js";
import { answerCurrent, currentStep, userId, type FakeBot } from "../helpers/learning.js";
import { finishSession as finishAll, type Decide } from "../helpers/practice.js";

const { db, close } = openTestDb();
afterAll(close);
beforeEach(() => resetDb(db));

let oidc: FakeOidc;
beforeAll(async () => {
  oidc = await createFakeOidc();
});

const TEACHER = 93001;
const OTHER_TEACHER = 93002;
const STUDENT = 93101;
const SECOND_STUDENT = 93102;
const NOW = new Date("2026-11-24T09:00:00Z");

const learner = (seed = 7) => createFakeBot(db, { now: () => NOW, rng: createSeededRng(seed) });

const CARDS = [
  cardInput("apple", "яблоко"),
  cardInput("bank", "банк"),
  cardInput("bank", "берег"),
  cardInput("cat", "кошка"),
  cardInput("dog", "собака"),
  // Пользовательский текст, который таблица приняла бы за формулу.
  cardInput("=HYPERLINK(\"http://evil.example\")", "+79990000000"),
];

const finishSession = (fake: FakeBot, telegramId: number, decide?: Decide) => finishAll(db, fake, telegramId, decide);

const press = (fake: FakeBot, telegramId: number, data: string) => fake.bot.handleUpdate(callbackUpdate(telegramId, data));

async function results(browser: Browser, studentId: number): Promise<StudentResults> {
  const response = await browser.get(at(apiRoutes.studentResults, studentId));
  expect(response.statusCode, response.body).toBe(200);
  return studentResults.parse(response.json());
}

/** Преподаватель, подключённый ученик, подборка CARDS выдана ему. */
async function setup() {
  const { browser } = await teacherSession(db, oidc, TEACHER);
  const student = await connectedStudent(db, browser, STUDENT, "Анна");
  const collection = await createCollection(browser, "Основы", CARDS);
  const issued = await issueTo(browser, collection.id, [student.id]);
  expect(issued.statusCode, issued.body).toBe(200);
  const copyId: number = issued.json().results[0].copyId;
  await db.update(users).set({ timezone: "Europe/Moscow" }).where(eq(users.telegramId, STUDENT));
  return { browser, student, collection, copyId };
}

describe("результаты ученика", () => {
  it("тест: просмотры, обе попытки, сложное слово, итог занятия и подборки — из сохранённых попыток", async () => {
    const { browser, student, copyId } = await setup();
    const fake = learner();

    // Ученик открыл одну карточку дважды и одну — один раз.
    const cards = await db.select().from(studentCards).where(eq(studentCards.studentCollectionId, copyId)).orderBy(studentCards.position);
    await press(fake, STUDENT, collectionCard(cards[0]!.id, 0));
    await press(fake, STUDENT, collectionCard(cards[0]!.id, 0));
    await press(fake, STUDENT, collectionCard(cards[1]!.id, 0));

    // apple: две ошибки — сложное; cat: ошибка и верный повтор; остальное верно.
    await press(fake, STUDENT, startTest(copyId));
    await finishSession(fake, STUDENT, (english, attempt) => (english === "apple" ? false : english === "cat" ? attempt === 2 : true));

    const data = await results(browser, student.id);
    expect(data.student).toMatchObject({ id: student.id, displayName: "Анна", status: "active", timezone: "Europe/Moscow" });
    expect(data.totals).toEqual({ answered: 6, firstAttempt: { correct: 4, total: 6 }, afterRepeat: { correct: 5, total: 6 } });

    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0]).toMatchObject({
      type: "test",
      title: "Основы",
      status: "completed",
      plannedCount: 6,
      answeredCount: 6,
      firstAttempt: { correct: 4, total: 6 },
      afterRepeat: { correct: 5, total: 6 },
      becameHard: 1,
      mastered: 0,
    });

    const apple = data.answers.find((answer) => answer.english === "apple")!;
    expect(apple).toMatchObject({ translation: "яблоко", first: { correct: false }, second: { correct: false }, becameHard: true });
    const cat = data.answers.find((answer) => answer.english === "cat")!;
    expect(cat).toMatchObject({ first: { correct: false }, second: { correct: true }, becameHard: false });
    const dog = data.answers.find((answer) => answer.english === "dog")!;
    expect(dog.second).toBeNull();
    expect(dog.first.correct).toBe(true);

    // «bank — банк» и «bank — берег» — разные слова; сложное слово первым.
    expect(data.words.map((word) => `${word.english} — ${word.translation}`)).toContain("bank — берег");
    expect(data.words.filter((word) => word.english === "bank")).toHaveLength(2);
    expect(data.words[0]).toMatchObject({ english: "apple", status: "hard", correctStreak: 0, sources: ["Основы"] });
    expect(data.words.find((word) => word.english === "cat")).toMatchObject({ status: "learning", firstAttempt: { correct: 0, total: 1 } });

    expect(data.progress).toMatchObject({ available: 6, studied: 6, hard: 1, mastered: 0, completedCollections: 1, totalCollections: 1 });
    expect(data.collections).toEqual([
      expect.objectContaining({ id: copyId, title: "Основы", status: "completed", wordCount: 6, viewedCards: 2, answeredWords: 6 }),
    ]);
    expect(data.views).toHaveLength(2);
    expect(data.views.find((view) => view.views === 2)).toMatchObject({ collectionTitle: "Основы" });
  });

  it("«Переведи меня», практика сложных слов, квест и экзамен видны отдельными занятиями; квест — с датой и серией", async () => {
    const { browser, student, copyId } = await setup();
    const fake = learner(3);

    await press(fake, STUDENT, startTranslate(copyId));
    await finishSession(fake, STUDENT, (english) => english !== "dog");
    await press(fake, STUDENT, "h:a");
    await finishSession(fake, STUDENT);
    await press(fake, STUDENT, DAILY_START);
    await finishSession(fake, STUDENT);
    await press(fake, STUDENT, EXAM_START);
    await finishSession(fake, STUDENT);

    const data = await results(browser, student.id);
    expect(data.sessions.map((session) => session.type).sort()).toEqual(["daily_quest", "exam", "hard_words", "translate"]);
    expect(data.sessions.every((session) => session.status === "completed")).toBe(true);
    const quest = data.sessions.find((session) => session.type === "daily_quest")!;
    expect(quest).toMatchObject({ questLocalDate: "2026-11-24", title: null });
    expect(data.progress).toMatchObject({ questsCompleted: 1, examsCompleted: 1, questStreak: 1 });
    const translate = data.sessions.find((session) => session.type === "translate")!;
    expect(translate.firstAttempt.correct).toBe(translate.firstAttempt.total - 1);
    // Ответы «Переведи меня» хранят введённый текст.
    expect(data.answers.find((answer) => answer.sessionType === "translate" && answer.english === "dog")?.first.answer).toBe(
      "заведомо неверный ответ",
    );
  });

  it("запись без аккаунта: подборки видны, ответов нет", async () => {
    const { browser } = await teacherSession(db, oidc, TEACHER);
    const waiting = await createStudent(browser, "Борис");
    const collection = await createCollection(browser, "Ждёт", [cardInput("sun", "солнце")]);
    await issueTo(browser, collection.id, [waiting.id]);
    const data = await results(browser, waiting.id);
    expect(data.student.status).toBe("pending_connection");
    expect(data.collections).toEqual([expect.objectContaining({ title: "Ждёт", wordCount: 1, viewedCards: 0, answeredWords: 0 })]);
    expect(data.sessions).toEqual([]);
    expect(data.words).toEqual([]);
    expect(data.progress.available).toBe(0);
  });

  it("ученик вернулся к тому же преподавателю: результаты прежней связи не видны ни в странице, ни в CSV", async () => {
    const { browser, student, copyId } = await setup();
    const fake = learner();
    await press(fake, STUDENT, startTest(copyId));
    await finishSession(fake, STUDENT, (english) => english !== "apple");
    expect((await results(browser, student.id)).totals.answered).toBe(6);

    expect((await browser.send("POST", at(apiRoutes.unlinkStudent, student.id))).statusCode).toBe(200);
    // После отвязки ученик ещё занимается по своей копии: эти ответы не принадлежат ни одной связи преподавателя.
    await press(fake, STUDENT, startTranslate(copyId));
    await finishSession(fake, STUDENT);

    const again = await connectedStudent(db, browser, STUDENT, "Анна снова");
    expect(again.id).not.toBe(student.id);
    const fresh = await results(browser, again.id);
    expect(fresh.totals.answered).toBe(0);
    expect(fresh.sessions).toEqual([]);
    expect(fresh.answers).toEqual([]);
    expect(fresh.views).toEqual([]);
    // Прежние подборки остаются у ученика, но к новой связи не относятся.
    expect(fresh.collections).toEqual([]);
    expect(fresh.words).toEqual([]);

    expect((await browser.get(at(apiRoutes.studentResults, student.id))).statusCode).toBe(404);
    expect((await browser.get(at(apiRoutes.studentResultsCsv, student.id))).statusCode).toBe(404);
    const csv = (await browser.get(at(apiRoutes.studentResultsCsv, again.id))).body;
    expect(csv).not.toContain("apple");
    expect(csv).not.toContain("Основы");

    // Новый период: новая выдача и ответы видны.
    const second = await createCollection(browser, "Второй период", [cardInput("sun", "солнце"), cardInput("moon", "луна")]);
    const copy2: number = (await issueTo(browser, second.id, [again.id])).json().results[0].copyId;
    await press(fake, STUDENT, startTest(copy2));
    await finishSession(fake, STUDENT);
    const later = await results(browser, again.id);
    expect(later.totals.answered).toBe(2);
    expect(later.answers.map((answer) => answer.english).sort()).toEqual(["moon", "sun"]);
  });

  it("чужой преподаватель получает 404 на результатах, CSV и результатах подборки; ничего не утекает", async () => {
    const { browser, student, collection, copyId } = await setup();
    await press(learner(), STUDENT, startTest(copyId));
    await finishSession(learner(), STUDENT);
    const other = await teacherSession(db, oidc, OTHER_TEACHER, "Борис");
    for (const url of [
      at(apiRoutes.studentResults, student.id),
      at(apiRoutes.studentResultsCsv, student.id),
      at(apiRoutes.collectionResults, collection.id),
    ]) {
      const response = await other.browser.get(url);
      expect(response.statusCode, url).toBe(404);
      expect(response.json().error.code).toBe("not_found");
      expect(response.body).not.toMatch(/apple|Анна|Основы/);
      expect(response.headers["content-disposition"]).toBeUndefined();
    }
    expect((await browser.get(at(apiRoutes.studentResultsCsv, student.id))).statusCode).toBe(200);
  });
});

describe("выгрузка CSV", () => {
  it("файл для Excel: BOM, «;», CRLF, имя файла; формулы не исполняются", async () => {
    const { browser, student, copyId } = await setup();
    const fake = learner();
    await press(fake, STUDENT, startTranslate(copyId));
    // Ответ ученика тоже пользовательский текст: «=…» с первой попытки, верный — на повторе.
    const id = await userId(db, STUDENT);
    let injected = false;
    for (let guard = 0; guard < 50; guard++) {
      const step = await currentStep(db, id);
      if (!step) break;
      if (!injected && step.version.english === "apple" && step.attemptNumber === 1) {
        expect(step.question.format).toBe("typed");
        await fake.bot.handleUpdate(textUpdate(STUDENT, "=SUM(A1;A2)"));
        injected = true;
      } else {
        await answerCurrent(fake, db, STUDENT, true);
      }
    }
    expect(injected).toBe(true);

    const response = await browser.get(at(apiRoutes.studentResultsCsv, student.id));
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("no-store");
    const disposition = String(response.headers["content-disposition"]);
    expect(disposition).toMatch(/^attachment; filename="results-\d{4}-\d{2}-\d{2}\.csv"; filename\*=UTF-8''/);
    expect(decodeURIComponent(disposition.split("''")[1]!)).toMatch(/^Результаты Анна \d{4}-\d{2}-\d{2}\.csv$/);

    const raw = response.rawPayload;
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = raw.toString("utf8");
    expect(text.startsWith(CSV_BOM)).toBe(true);
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text.replaceAll("\r\n", "")).not.toContain("\n");
    const lines = text.slice(1).split("\r\n");
    expect(lines[0]).toBe("Результаты ученика;Анна");
    expect(lines).toContain("Часовой пояс дат;Europe/Moscow");
    expect(lines).toContain("Сложных слов;0");

    // Ни одна ячейка не начинается с символа формулы: у опасных значений впереди апостроф.
    const cells = lines.flatMap((line) => splitCsvLine(line));
    expect(cells.filter((cell) => /^[=+\-@\t\r]/.test(cell))).toEqual([]);
    expect(cells).toContain(`'=HYPERLINK("http://evil.example")`);
    expect(cells).toContain("'+79990000000");
    expect(cells).toContain("'=SUM(A1;A2)");
    // Обычный текст не трогается.
    expect(cells).toContain("яблоко");
  });

  it("csvCell: апостроф у =, +, -, @, табуляции и CR; кавычки по RFC 4180; числа как есть", () => {
    expect(csvCell("=1+2")).toBe("'=1+2");
    expect(csvCell("+7")).toBe("'+7");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\t=1")).toBe("'\t=1");
    expect(csvCell("\r=1")).toBe("\"'\r=1\"");
    expect(csvCell("=A1;B1")).toBe("\"'=A1;B1\"");
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("a;b")).toBe('"a;b"');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell(" padded")).toBe('" padded"');
    expect(csvCell("ёжик")).toBe("ёжик");
    expect(csvCell("a=b")).toBe("a=b");
    expect(csvCell(5)).toBe("5");
    expect(csvCell(null)).toBe("");
    expect(csvDocument([["a", "b"], [1]])).toBe("﻿a;b\r\n1\r\n");
  });

  it("даты в часовом поясе ученика, без пояса — UTC", () => {
    expect(formatCsvDate("2026-11-24T21:30:00Z", "Europe/Moscow")).toBe("2026-11-25 00:30");
    expect(formatCsvDate("2026-11-24T21:30:00Z", "UTC")).toBe("2026-11-24 21:30");
    expect(formatCsvDate(null, "UTC")).toBe("");
  });
});

describe("результаты по подборке", () => {
  it("копии объединяются по исходной карточке; кто получил, начал и завершил; трудные слова первыми; отвязанные не видны", async () => {
    const { browser, student, collection, copyId } = await setup();
    const second = await connectedStudent(db, browser, SECOND_STUDENT, "Вера");
    const waiting = await createStudent(browser, "Глеб");
    const copy2: number = (await issueTo(browser, collection.id, [second.id, waiting.id])).json().results[0].copyId;

    await press(learner(), STUDENT, startTest(copyId));
    await finishSession(learner(), STUDENT, (english) => english !== "apple");
    await press(learner(5), SECOND_STUDENT, startTest(copy2));
    await finishSession(learner(5), SECOND_STUDENT, (english, attempt) => english !== "apple" && (english !== "cat" || attempt === 2));

    const response = await browser.get(at(apiRoutes.collectionResults, collection.id));
    expect(response.statusCode, response.body).toBe(200);
    const data = collectionResults.parse(response.json());
    expect(data.title).toBe("Основы");
    expect(data.recipients.map((recipient) => [recipient.displayName, recipient.status, recipient.firstAttempt.total])).toEqual([
      ["Анна", "completed", 6],
      ["Вера", "completed", 6],
      ["Глеб", "assigned", 0],
    ]);
    expect(data.words[0]).toMatchObject({ english: "apple", students: 2, firstAttempt: { correct: 0, total: 2 }, becameHard: 2, hardNow: 2 });
    expect(data.words[1]).toMatchObject({ english: "cat", students: 2, firstAttempt: { correct: 1, total: 2 }, becameHard: 0 });
    expect(data.words.filter((word) => word.english === "bank")).toHaveLength(2);
    expect(data.words.every((word) => word.sourceCardId !== null)).toBe(true);

    // Отвязанный ученик и его ответы исчезают из результатов подборки.
    await browser.send("POST", at(apiRoutes.unlinkStudent, student.id));
    const after = collectionResults.parse((await browser.get(at(apiRoutes.collectionResults, collection.id))).json());
    expect(after.recipients.map((recipient) => recipient.displayName)).toEqual(["Вера", "Глеб"]);
    expect(after.words[0]).toMatchObject({ english: "apple", students: 1, becameHard: 1 });
    const [ownCopy] = await db.select().from(studentCollections).where(eq(studentCollections.id, copyId));
    expect(ownCopy?.deletedAt).toBeNull();
  });
});

describe("главная", () => {
  it("недавно выданные подборки и последние завершённые занятия — только своих текущих учеников", async () => {
    const { browser, student, copyId } = await setup();
    await press(learner(), STUDENT, startTest(copyId));
    await finishSession(learner(), STUDENT, (english) => english !== "dog");
    const other = await teacherSession(db, oidc, OTHER_TEACHER, "Борис");

    const own = dashboardResponse.parse((await browser.get(apiRoutes.dashboard.path)).json());
    expect(own.recentCollections).toEqual([expect.objectContaining({ copyId, studentId: student.id, displayName: "Анна", title: "Основы" })]);
    expect(own.recentResults).toEqual([
      expect.objectContaining({ studentId: student.id, type: "test", title: "Основы", firstAttempt: { correct: 5, total: 6 } }),
    ]);
    const foreign = dashboardResponse.parse((await other.browser.get(apiRoutes.dashboard.path)).json());
    expect(foreign.recentCollections).toEqual([]);
    expect(foreign.recentResults).toEqual([]);

    await browser.send("POST", at(apiRoutes.unlinkStudent, student.id));
    const afterUnlink = dashboardResponse.parse((await browser.get(apiRoutes.dashboard.path)).json());
    expect(afterUnlink.recentCollections).toEqual([]);
    expect(afterUnlink.recentResults).toEqual([]);
  });
});

/** Разбор строки CSV с «;» и кавычками RFC 4180 — для проверки, а не для работы сервиса. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index++;
      } else if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"') quoted = true;
    else if (char === ";") {
      cells.push(current);
      current = "";
    } else current += char;
  }
  cells.push(current);
  return cells;
}
