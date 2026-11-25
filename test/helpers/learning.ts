import { and, eq, sql } from "drizzle-orm";
import { ANSWER_PATTERN, answerButton, collectionPage, collectionsPage, startTest } from "../../src/bot/callback-data.js";
import { createDb, type Db } from "../../src/db/client.js";
import type { FixtureCard, FixtureCollection } from "../../src/db/fixtures.js";
import { cardVersions, questions, sessions, studentCards, studentCollections, studentWords, users } from "../../src/db/schema.js";
import { issueFixtureCollection } from "../../src/learning/issue.js";
import { TEST_DATABASE_URL } from "./db.js";
import { nextStep, primaryAnswerText } from "../../src/domain/learning/index.js";
import { callbackUpdate, createFakeBot, lastButtons, textUpdate, type ApiCall } from "./fake-telegram.js";
import { connectDirectly, makeTeacher } from "./linking.js";

export type FakeBot = ReturnType<typeof createFakeBot>;
export type Button = { text: string; callback_data: string };

export const card = (english: string, translation: string, extra: Partial<FixtureCard> = {}): FixtureCard => ({
  english,
  translation,
  acceptedRuEn: [],
  acceptedEnRu: [],
  allowOmitTo: false,
  example: null,
  explanation: null,
  ...extra,
});

export const words = (count: number, prefix = "word") =>
  Array.from({ length: count }, (_, index) => card(`${prefix}${index + 1}`, `слово-${prefix}-${index + 1}`));

/** Выдаёт подборку с заданными карточками. Возвращает ID копии. */
export async function issue(db: Db, studentLinkId: number, title: string, cards: FixtureCard[]) {
  const fixtures: FixtureCollection[] = [{ title, cards }];
  const { studentCollectionId } = await issueFixtureCollection(db, { studentLinkId, title, fixtures });
  return studentCollectionId;
}

export async function connectStudent(db: Db, telegramId: number, teacherTelegramId = telegramId + 100000) {
  const teacher = await makeTeacher(db, teacherTelegramId);
  const { student, link } = await connectDirectly(db, teacher.id, telegramId);
  return { teacher, student, link };
}

export const answerButtons = (calls: ApiCall[]): Button[] =>
  lastButtons(calls).filter((button) => ANSWER_PATTERN.test(button.callback_data));

export function parseAnswer(data: string) {
  const match = data.match(ANSWER_PATTERN);
  if (!match) throw new Error(`Не кнопка ответа: ${data}`);
  return { questionId: Number(match[1]), attemptNumber: Number(match[2]), optionIndex: Number(match[3]) };
}

export async function questionOf(db: Db, buttons: Button[]) {
  const { questionId } = parseAnswer(buttons[0]!.callback_data);
  const [row] = await db
    .select({ question: questions, version: cardVersions })
    .from(questions)
    .innerJoin(cardVersions, eq(cardVersions.id, questions.cardVersionId))
    .where(eq(questions.id, questionId));
  if (!row) throw new Error(`Вопрос ${questionId} не найден`);
  return row;
}

export async function correctButton(db: Db, buttons: Button[]): Promise<Button> {
  const { question } = await questionOf(db, buttons);
  const button = buttons.find((item) => parseAnswer(item.callback_data).optionIndex === question.correctOptionIndex);
  if (!button) throw new Error("Нет кнопки с верным ответом");
  return button;
}

export async function wrongButton(db: Db, buttons: Button[]): Promise<Button> {
  const { question } = await questionOf(db, buttons);
  const button = buttons.find((item) => parseAnswer(item.callback_data).optionIndex !== question.correctOptionIndex);
  if (!button) throw new Error("Нет кнопки с неверным ответом");
  return button;
}

/** Отвечает на последний показанный вопрос и возвращает нажатую кнопку. */
export async function answer({ bot, calls }: FakeBot, db: Db, telegramId: number, correct: boolean): Promise<Button> {
  const buttons = answerButtons(calls);
  const button = correct ? await correctButton(db, buttons) : await wrongButton(db, buttons);
  await bot.handleUpdate(callbackUpdate(telegramId, button.callback_data));
  return button;
}

/** Настоящий путь ученика: Подборки, подборка, «Начать тест». */
export async function startThroughMenu({ bot, calls }: FakeBot, telegramId: number, collectionId: number) {
  await bot.handleUpdate(callbackUpdate(telegramId, collectionsPage(0)));
  await bot.handleUpdate(callbackUpdate(telegramId, collectionPage(collectionId, 0)));
  const start = lastButtons(calls).find((button) => button.callback_data === startTest(collectionId));
  if (!start) throw new Error("Нет кнопки «Начать тест»");
  await bot.handleUpdate(callbackUpdate(telegramId, start.callback_data));
}

/** «Перезапуск»: новое соединение и новый бот, в памяти прежнего ничего не остаётся. */
export async function withRestart<T>(run: (fake: FakeBot, db: Db) => Promise<T>): Promise<T> {
  const restarted = createDb(TEST_DATABASE_URL);
  try {
    return await run(createFakeBot(restarted.db), restarted.db);
  } finally {
    await restarted.close();
  }
}

export async function userId(db: Db, telegramId: number) {
  const [user] = await db.select().from(users).where(eq(users.telegramId, telegramId));
  return user!.id;
}

export async function wordByPair(db: Db, studentUserId: number, english: string, translation: string) {
  const [word] = await db
    .select()
    .from(studentWords)
    .where(
      and(
        eq(studentWords.studentUserId, studentUserId),
        eq(studentWords.normalizedEnglish, english),
        eq(studentWords.normalizedTranslation, translation),
      ),
    );
  if (!word) throw new Error(`Слова ${english} — ${translation} нет`);
  return word;
}

/** Карточка копии, текущая версия которой имеет этот английский текст. */
export async function cardByEnglish(db: Db, collectionId: number, english: string) {
  const rows = await db
    .select({ card: studentCards, version: cardVersions })
    .from(studentCards)
    .innerJoin(cardVersions, eq(cardVersions.studentCardId, studentCards.id))
    .where(and(eq(studentCards.studentCollectionId, collectionId), eq(cardVersions.english, english)));
  if (!rows[0]) throw new Error(`Карточки ${english} нет`);
  return rows[0];
}

/** Правка карточки: новая версия, как на этапе 4. */
export async function editCard(db: Db, collectionId: number, english: string, patch: Partial<typeof cardVersions.$inferInsert>) {
  const { card: row, version } = await cardByEnglish(db, collectionId, english);
  const { id: _id, createdAt: _createdAt, ...rest } = version;
  const [created] = await db
    .insert(cardVersions)
    .values({ ...rest, ...patch, versionNumber: version.versionNumber + 1 })
    .returning();
  return { card: row, version: created! };
}

export async function deleteCard(db: Db, collectionId: number, english: string) {
  const { card: row } = await cardByEnglish(db, collectionId, english);
  await db.update(studentCards).set({ deletedAt: new Date() }).where(eq(studentCards.id, row.id));
}

export async function sessionOf(db: Db, sessionId: number) {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  return session!;
}

export const collectionStatus = async (db: Db, id: number) =>
  (await db.select({ status: studentCollections.status }).from(studentCollections).where(eq(studentCollections.id, id)))[0]!.status;

/** Ждёт, пока другое соединение повиснет на блокировке: без пауз «на глаз». */
export async function waitForBlockedQuery(db: Db) {
  for (let i = 0; i < 400; i++) {
    const result = await db.execute(
      sql`SELECT count(*)::int AS blocked FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (Number(result.rows[0]?.blocked) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Запрос так и не встал на блокировку");
}

/** Текущий шаг текущего занятия ученика: вопрос, его версия и номер попытки. Пусто, если отвечать не на что. */
export async function currentStep(db: Db, studentUserId: number) {
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.studentUserId, studentUserId), eq(sessions.status, "current")));
  if (!session?.learningState) return null;
  const step = nextStep(session.learningState);
  if (step.kind === "finished") return null;
  const [row] = await db
    .select({ question: questions, version: cardVersions })
    .from(questions)
    .innerJoin(cardVersions, eq(cardVersions.id, questions.cardVersionId))
    .where(and(eq(questions.sessionId, session.id), eq(questions.position, step.position)));
  if (!row) return null;
  return { ...row, session, attemptNumber: step.attemptNumber, isRepeat: step.kind === "repeat" };
}

/** Заведомо неверный ввод: не совпадает ни с одним вариантом тестовых карточек. */
export const WRONG_TEXT = "заведомо неверный ответ";

/**
 * Отвечает на текущий вопрос так, как ответил бы ученик: кнопкой или сообщением.
 * Возвращает отвеченный шаг.
 */
export async function answerCurrent(fake: FakeBot, db: Db, telegramId: number, correct: boolean) {
  const step = await currentStep(db, await userId(db, telegramId));
  if (!step) throw new Error("Нет текущего вопроса");
  if (step.question.format === "choice") {
    // Кнопка строится по вопросу текущего шага, а не по последнему сообщению: последним может быть,
    // например, список «Сложных слов». Бот сам проверит, что кнопка относится к текущему шагу.
    const options = step.question.options ?? [];
    const correctIndex = step.question.correctOptionIndex!;
    const optionIndex = correct ? correctIndex : options.findIndex((_, index) => index !== correctIndex);
    if (optionIndex < 0) throw new Error("Нет неверного варианта");
    await fake.bot.handleUpdate(callbackUpdate(telegramId, answerButton(step.question.id, step.attemptNumber, optionIndex)));
  } else {
    const text = correct ? primaryAnswerText(step.version, step.question.direction) : WRONG_TEXT;
    await fake.bot.handleUpdate(textUpdate(telegramId, text));
  }
  return step;
}
