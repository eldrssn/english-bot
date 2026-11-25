// Только для разработки: ученик проходит тест по каждой своей подборке, чтобы в кабинете появились результаты.
// Ответы идут через настоящую логику обучения (те же записи попыток, что и из бота), Telegram не нужен.
// Слова из wrong ученик дважды отвечает неверно: они попадают в «Сложные». Остальные — верно с первой попытки.
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { cardVersions, questions, users } from "../db/schema.js";
import { primaryAnswerText, type Rng } from "../domain/learning/index.js";
import { createLearningService, type SessionProgress } from "../learning/service.js";
import { listVisibleCollections } from "../learning/vocabulary.js";

export class PracticeStudentError extends Error {
  override name = "PracticeStudentError";
}

export type PracticeStudentInput = {
  studentTelegramId: number;
  /** Английские слова, на которые ученик ответит неверно оба раза. */
  wrong?: readonly string[];
  rng?: Rng;
  now?: () => Date;
};

export type PracticeStudentResult = {
  sessions: { title: string; answered: number; firstAttemptCorrect: number; becameHard: string[] }[];
};

const WRONG_TEXT = "заведомо неверный ответ";

export async function practiceStudent(db: Db, input: PracticeStudentInput): Promise<PracticeStudentResult> {
  const [user] = await db.select().from(users).where(eq(users.telegramId, input.studentTelegramId));
  if (!user || user.role !== "student") throw new PracticeStudentError(`Ученик с Telegram ID ${input.studentTelegramId} не найден`);
  const wrong = new Set((input.wrong ?? []).map((word) => word.trim().toLowerCase()));
  const learning = createLearningService(db, { ...(input.rng ? { rng: input.rng } : {}), ...(input.now ? { now: input.now } : {}) });
  // Номера «сообщений» для вопросов с вводом: ответ должен прийти после показа вопроса.
  let messageId = 1;

  const result: PracticeStudentResult = { sessions: [] };
  for (const collection of await listVisibleCollections(db, user.id)) {
    const started = await learning.startCollectionSession({ userId: user.id, collectionId: collection.id, type: "test" });
    if (started.kind !== "started") continue;
    let progress: SessionProgress = started.progress;
    for (let guard = 0; progress.kind === "question" && guard < 1000; guard++) {
      const asked = progress.question;
      const [row] = await db
        .select({ question: questions, version: cardVersions })
        .from(questions)
        .innerJoin(cardVersions, eq(cardVersions.id, questions.cardVersionId))
        .where(and(eq(questions.id, asked.questionId), eq(questions.sessionId, asked.sessionId)));
      if (!row) throw new PracticeStudentError(`Вопрос ${asked.questionId} не найден`);
      const correct = !wrong.has(row.version.english.trim().toLowerCase());

      if (row.question.format === "choice") {
        const right = row.question.correctOptionIndex!;
        const optionIndex = correct ? right : (row.question.options ?? []).findIndex((_, index) => index !== right);
        const answered = await learning.answerChoice({
          userId: user.id,
          questionId: row.question.id,
          attemptNumber: asked.attemptNumber,
          optionIndex,
        });
        if (answered.kind !== "answered") throw new PracticeStudentError(`Ответ не принят: ${answered.kind}`);
        progress = answered.next;
      } else {
        await learning.markQuestionShown({ userId: user.id, questionId: row.question.id, messageId: messageId++ });
        const text = correct ? primaryAnswerText(row.version, row.question.direction) : WRONG_TEXT;
        const answered = await learning.answerTyped({ userId: user.id, text, messageId: messageId++ });
        if (answered.kind !== "answered") throw new PracticeStudentError(`Ответ не принят: ${answered.kind}`);
        progress = answered.next;
      }
    }
    if (progress.kind === "finished") {
      result.sessions.push({
        title: collection.title,
        answered: progress.result.answeredCount,
        firstAttemptCorrect: progress.result.firstAttemptCorrect,
        becameHard: progress.result.becameHard.map((pair) => pair.english),
      });
    }
  }
  return result;
}
