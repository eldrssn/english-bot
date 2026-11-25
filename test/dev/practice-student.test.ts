// Скрипт разработки dev:student-practice: ученик проходит тесты, в кабинете появляются результаты.
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { studentWords } from "../../src/db/schema.js";
import { createSeededRng } from "../../src/domain/learning/index.js";
import { PracticeStudentError, practiceStudent } from "../../src/dev/practice-student.js";
import { getStudentResults } from "../../src/results/student-results.js";
import { openTestDb, resetDb } from "../helpers/db.js";
import { card, connectStudent, issue, words } from "../helpers/learning.js";

const { db, close } = openTestDb();
afterAll(close);
beforeEach(() => resetDb(db));

const STUDENT = 95101;
const NOW = new Date("2026-11-24T09:00:00Z");

describe("dev:student-practice", () => {
  it("проходит тест по каждой подборке; слова из --wrong становятся сложными; результаты видны преподавателю", async () => {
    const { teacher, student, link } = await connectStudent(db, STUDENT);
    await issue(db, link.id, "Первая", [card("apple", "яблоко"), ...words(4, "a")]);
    await issue(db, link.id, "Вторая", words(3, "b"));

    const result = await practiceStudent(db, { studentTelegramId: STUDENT, wrong: ["Apple"], rng: createSeededRng(2), now: () => NOW });
    expect(result.sessions.map((session) => [session.title, session.answered, session.becameHard])).toEqual(
      expect.arrayContaining([
        ["Первая", 5, ["apple"]],
        ["Вторая", 3, []],
      ]),
    );
    const hard = await db.select().from(studentWords).where(eq(studentWords.status, "hard"));
    expect(hard.map((word) => word.normalizedEnglish)).toEqual(["apple"]);

    const results = await getStudentResults(db, teacher.id, link.id, { now: NOW });
    expect(results?.totals).toEqual({ answered: 8, firstAttempt: { correct: 7, total: 8 }, afterRepeat: { correct: 7, total: 8 } });
    expect(results?.progress).toMatchObject({ hard: 1, completedCollections: 2 });
    expect(student.id).toBeGreaterThan(0);
  });

  it("неизвестный Telegram ID: понятная ошибка", async () => {
    await expect(practiceStudent(db, { studentTelegramId: 1 })).rejects.toBeInstanceOf(PracticeStudentError);
  });
});
