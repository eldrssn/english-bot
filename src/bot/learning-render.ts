// Тексты и разметка учебных разделов. Без обращений к базе и Telegram.
import { InlineKeyboard } from "grammy";
import { LEARNING_SETTINGS } from "../domain/learning/settings.js";
import type {
  AnswerFeedback,
  AskedQuestion,
  CollectionCardScreen,
  CollectionScreen,
  HardWord,
  HardWordsScreen,
  OpenSession,
  SessionResult,
  WordPair,
  WordProgress,
} from "../learning/service.js";
import type { VisibleCollection, VocabularyWord } from "../learning/vocabulary.js";
import {
  DAILY_OPEN,
  EXAM_OPEN,
  MENU,
  PROGRESS_OPEN,
  SETTINGS_OPEN,
  START_HARD_ALL,
  answerButton,
  collectionCard,
  collectionPage,
  collectionsPage,
  hardWordsPage,
  pauseSession,
  resumeSession,
  startHardSelected,
  startTest,
  startTranslate,
  wordCard,
  wordsPage,
} from "./callback-data.js";

/** Лимит Telegram на сообщение. */
export const MESSAGE_LIMIT = 4096;
/** Запас на заголовок и подвал страницы. */
const PAGE_BODY_LIMIT = 3600;
const PAGE_MAX_ITEMS = 8;
/** Длинная строка списка обрезается, полный текст есть в карточке. */
const LIST_LINE_LIMIT = 500;
/** Telegram обрезает длинные подписи кнопок сам, причём по-разному на разных устройствах. */
export const BUTTON_LABEL_LIMIT = 40;

export const LEARNING_TEXTS = {
  menu: "Выберите раздел.",
  menuFormer:
    "Преподаватель больше не ведёт ваши занятия. Вы можете заниматься по полученным материалам, новых материалов не будет.",
  help:
    "Выберите раздел в меню. В тесте ответ выбирается кнопкой, в «Переведи меня» перевод пишется сообщением. Прерванное занятие можно продолжить из меню.",
  noOpenQuestionHint: "Сейчас ответ выбирается кнопкой под вопросом. Чтобы вернуться к нему, нажмите «Продолжить».",
  earlyAnswer: "Это сообщение отправлено раньше вопроса и не засчитано. Ответьте на вопрос ниже.",
  blankAnswer: "Напишите перевод словами: в сообщении нет ни одной буквы. Ответ не засчитан.",
  staleCallback: "Этот вопрос уже неактуален.",
  answeredCallback: "Ответ на этот вопрос уже записан.",
  pausedCallback: "Это занятие на паузе.",
  finishedCallback: "Это занятие уже завершено.",
  pausedMessage: "Это занятие на паузе, ответ не записан. Нажмите «Продолжить», чтобы вернуться к нему.",
  paused: "Занятие на паузе. Вернуться к нему можно кнопкой «Продолжить».",
  pausedPrevious: "Предыдущее занятие на паузе, к нему можно вернуться из меню.",
  obsoleteButton: "Эта кнопка устарела.",
  noWords: "Слов пока нет. Они появятся, когда преподаватель выдаст подборку.",
  noCollections: "Подборок пока нет. Они появятся, когда преподаватель их выдаст.",
  emptyCollection: "В этой подборке пока нет слов.",
  collectionNotFound: "Подборка не найдена.",
  cardNotFound: "Этой карточки больше нет.",
  sessionNotFound: "Занятие не найдено.",
  becameHard: "Слово попало в «Сложные слова».",
  returnedToHard: "Слово снова попало в «Сложные слова»: две ошибки подряд.",
  mastered: `Слово освоено: ${LEARNING_SETTINGS.masteryStreak} верных ответов подряд с первой попытки. Оно уходит из «Сложных слов».`,
  streakReset: "Серия «5 из 5» начинается заново.",
  noHardWords:
    "Сложных слов нет. Слово попадает сюда, если ошибиться на нём дважды в одной серии: в тесте, «Переведи меня» или практике.",
  hardWordsChanged: "Список сложных слов изменился. Выберите слова ещё раз.",
} as const;

export function fitMessage(text: string): string {
  return text.length <= MESSAGE_LIMIT ? text : `${text.slice(0, MESSAGE_LIMIT - 1)}…`;
}

function clip(text: string, limit: number): string {
  const chars = [...text];
  return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join("")}…`;
}

const pairText = (pair: WordPair) => `${pair.english} — ${pair.translation}`;

/**
 * Делит строки на страницы: не больше PAGE_MAX_ITEMS пунктов и не больше PAGE_BODY_LIMIT символов.
 * На странице всегда есть хотя бы один пункт: длинный пункт обрезан заранее.
 */
export function paginate<T>(items: readonly T[], lineOf: (item: T) => string): T[][] {
  const pages: T[][] = [];
  let page: T[] = [];
  let length = 0;
  for (const item of items) {
    const lineLength = lineOf(item).length + 1;
    if (page.length > 0 && (page.length >= PAGE_MAX_ITEMS || length + lineLength > PAGE_BODY_LIMIT)) {
      pages.push(page);
      page = [];
      length = 0;
    }
    page.push(item);
    length += lineLength;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

export const clampPage = (page: number, pageCount: number) => Math.min(page, Math.max(pageCount - 1, 0));

function navigationRow(keyboard: InlineKeyboard, page: number, pageCount: number, target: (page: number) => string) {
  if (pageCount <= 1) return;
  if (page > 0) keyboard.text("← Назад", target(page - 1));
  keyboard.text(`${page + 1} / ${pageCount}`, target(page));
  if (page < pageCount - 1) keyboard.text("Вперёд →", target(page + 1));
  keyboard.row();
}

const toMenu = (keyboard: InlineKeyboard) => keyboard.text("В меню", MENU);

// ---------- Меню ----------

const OPEN_SESSIONS_IN_MENU = 3;

export function menuKeyboard(open: readonly OpenSession[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const session of open.slice(0, OPEN_SESSIONS_IN_MENU)) {
    keyboard.text(clip(openSessionLabel(session), BUTTON_LABEL_LIMIT), resumeSession(session.sessionId)).row();
  }
  return keyboard
    .text("Все слова", wordsPage(0))
    .text("Подборки", collectionsPage(0))
    .row()
    .text("Сложные слова", hardWordsPage(0))
    .text("Ежедневная практика", DAILY_OPEN)
    .row()
    .text("Экзамен", EXAM_OPEN)
    .text("Мой прогресс", PROGRESS_OPEN)
    .row()
    .text("Настройки", SETTINGS_OPEN);
}

function openSessionLabel(session: OpenSession): string {
  if (session.type === "hard_words") return "Продолжить: сложные слова";
  if (session.type === "daily_quest") return "Продолжить: ежедневная практика";
  if (session.type === "exam") return "Продолжить экзамен";
  const title = session.title ?? "занятие";
  return session.type === "translate" ? `Продолжить «Переведи меня»: ${title}` : `Продолжить: ${title}`;
}

// ---------- Все слова ----------

const sourcesText = (sources: readonly string[]) => sources.join(", ");
const wordLine = (word: VocabularyWord, number: number) =>
  clip(`${number}. ${word.english} — ${word.translation} (${sourcesText(word.sources)})`, LIST_LINE_LIMIT);

export type Screen = { text: string; keyboard: InlineKeyboard };

export function wordsScreen(words: readonly VocabularyWord[], requestedPage: number): Screen {
  if (words.length === 0) return { text: LEARNING_TEXTS.noWords, keyboard: toMenu(new InlineKeyboard()) };
  const numbered = words.map((word, index) => ({ word, number: index + 1 }));
  const pages = paginate(numbered, ({ word, number }) => wordLine(word, number));
  const page = clampPage(requestedPage, pages.length);
  const items = pages[page] ?? [];
  const keyboard = new InlineKeyboard();
  for (const { word, number } of items) {
    keyboard.text(clip(`${number}. ${word.english}`, BUTTON_LABEL_LIMIT), wordCard(word.studentWordId, page)).row();
  }
  navigationRow(keyboard, page, pages.length, wordsPage);
  toMenu(keyboard);
  const lines = items.map(({ word, number }) => wordLine(word, number));
  return { text: fitMessage([`Все слова: ${words.length}.`, "", ...lines].join("\n")), keyboard };
}

function contentLines(card: { english: string; translation: string; example: string | null; explanation: string | null }) {
  return [pairText(card), ...(card.example ? ["", card.example] : []), ...(card.explanation ? ["", card.explanation] : [])];
}

export function wordCardScreen(word: VocabularyWord, page: number): Screen {
  const text = [...contentLines(word), "", `Подборки: ${sourcesText(word.sources)}`].join("\n");
  return {
    text: fitMessage(text),
    keyboard: toMenu(new InlineKeyboard().text("К списку слов", wordsPage(page))),
  };
}

// ---------- Подборки ----------

const formatDate = (date: Date, timezone: string | null) =>
  new Intl.DateTimeFormat("ru-RU", { timeZone: timezone ?? "UTC" }).format(date);

export function collectionsScreen(
  collections: readonly VisibleCollection[],
  requestedPage: number,
  timezone: string | null,
): Screen {
  if (collections.length === 0) return { text: LEARNING_TEXTS.noCollections, keyboard: toMenu(new InlineKeyboard()) };
  const line = (collection: VisibleCollection) =>
    clip(`${collection.title} · слов: ${collection.wordCount} · ${formatDate(collection.publishedAt, timezone)}`, LIST_LINE_LIMIT);
  const pages = paginate(collections, line);
  const page = clampPage(requestedPage, pages.length);
  const items = pages[page] ?? [];
  const keyboard = new InlineKeyboard();
  for (const collection of items) {
    keyboard.text(clip(collection.title, BUTTON_LABEL_LIMIT), collectionPage(collection.id, 0)).row();
  }
  navigationRow(keyboard, page, pages.length, collectionsPage);
  toMenu(keyboard);
  return { text: fitMessage(["Ваши подборки:", "", ...items.map(line)].join("\n")), keyboard };
}

type CollectionCardItem = CollectionScreen["cards"][number];

export function collectionScreen(
  screen: CollectionScreen,
  requestedPage: number,
  timezone: string | null,
): Screen & { shownCardIds: number[] } {
  const { collection, cards, openSessions } = screen;
  const line = (card: CollectionCardItem, number: number) => {
    const mark = card.isNew ? ` [новая, ${formatDate(card.addedAt, timezone)}]` : "";
    return clip(`${number}. ${card.version.english} — ${card.version.primaryTranslation}${mark}`, LIST_LINE_LIMIT);
  };
  const numbered = cards.map((card, index) => ({ card, number: index + 1 }));
  const pages = paginate(numbered, ({ card, number }) => line(card, number));
  const page = clampPage(requestedPage, pages.length);
  const items = pages[page] ?? [];

  const keyboard = new InlineKeyboard();
  if (openSessions.test !== null) keyboard.text("Продолжить тест", resumeSession(openSessions.test));
  else if (cards.length > 0) keyboard.text("Начать тест", startTest(collection.id));
  if (openSessions.translate !== null) keyboard.text("Продолжить «Переведи меня»", resumeSession(openSessions.translate));
  else if (cards.length > 0) keyboard.text("Переведи меня", startTranslate(collection.id));
  if (openSessions.test !== null || openSessions.translate !== null || cards.length > 0) keyboard.row();
  for (const { card, number } of items) {
    keyboard.text(clip(`${number}. ${card.version.english}`, BUTTON_LABEL_LIMIT), collectionCard(card.cardId, page)).row();
  }
  navigationRow(keyboard, page, pages.length, (target) => collectionPage(collection.id, target));
  keyboard.text("К подборкам", collectionsPage(0));
  toMenu(keyboard);

  const header = `${collection.title}\nОпубликована: ${formatDate(collection.publishedAt, timezone)}. Слов: ${cards.length}.`;
  const body = items.length > 0 ? items.map(({ card, number }) => line(card, number)) : [LEARNING_TEXTS.emptyCollection];
  return {
    text: fitMessage([header, "", ...body].join("\n")),
    keyboard,
    shownCardIds: items.map(({ card }) => card.cardId),
  };
}

export function collectionCardScreen(screen: CollectionCardScreen, page: number): Screen {
  const keyboard = new InlineKeyboard();
  if (screen.previousCardId !== null) keyboard.text("← Предыдущая", collectionCard(screen.previousCardId, page));
  if (screen.nextCardId !== null) keyboard.text("Следующая →", collectionCard(screen.nextCardId, page));
  if (screen.previousCardId !== null || screen.nextCardId !== null) keyboard.row();
  keyboard.text("К подборке", collectionPage(screen.collectionId, page));
  toMenu(keyboard);
  return { text: fitMessage(contentLines(screen.card).join("\n")), keyboard };
}

// ---------- Тест ----------

const DIRECTION_HINT = { ru_en: "Выберите перевод на английский", en_ru: "Выберите перевод на русский" } as const;
const TYPED_HINT = { ru_en: "Напишите перевод на английский", en_ru: "Напишите перевод на русский" } as const;
export const TYPED_FALLBACK_NOTE = "Других вариантов для кнопок не нашлось, поэтому перевод нужно написать сообщением.";

const questionHeader = (question: Pick<AskedQuestion, "isRepeat" | "number" | "total">) =>
  question.isRepeat ? "Повтор ошибки" : `Вопрос ${question.number} из ${question.total}`;

/** «Переведи меня»: ответ пишется сообщением, под вопросом только пауза. */
export function typedQuestionScreen(question: AskedQuestion): Screen {
  const lines = [questionHeader(question), "", `${TYPED_HINT[question.direction]}:`, question.prompt];
  if (question.typedFallback) lines.push("", TYPED_FALLBACK_NOTE);
  return { text: fitMessage(lines.join("\n")), keyboard: new InlineKeyboard().text("На паузу", pauseSession(question.sessionId)) };
}

/**
 * Длинный вариант на кнопке обрезается. Обрезка могла бы сделать варианты неразличимыми, поэтому при любой обрезке
 * кнопки нумеруются, а полный текст всех вариантов идёт в сообщении.
 */
export function questionScreen(question: AskedQuestion): Screen {
  if (question.format === "typed") return typedQuestionScreen(question);
  const needsFullText = question.options.some((option) => [...option].length > BUTTON_LABEL_LIMIT);
  const label = (option: string, index: number) =>
    needsFullText ? clip(`${index + 1}. ${option}`, BUTTON_LABEL_LIMIT) : option;

  const keyboard = new InlineKeyboard();
  question.options.forEach((option, index) => {
    keyboard.text(label(option, index), answerButton(question.questionId, question.attemptNumber, index)).row();
  });
  keyboard.text("На паузу", pauseSession(question.sessionId));

  const lines = [questionHeader(question), "", `${DIRECTION_HINT[question.direction]}:`, question.prompt];
  if (needsFullText) lines.push("", ...question.options.map((option, index) => `${index + 1}. ${option}`));
  return { text: fitMessage(lines.join("\n")), keyboard };
}

/** Длинный ввод ученика в ответе бота обрезается: целиком он сохранён в попытке. */
const TYPED_ECHO_LIMIT = 300;

/**
 * Кнопки — дословно по разделу 5 сценария: «Верно» и пара; «Вы выбрали …; верно …».
 * Ввод — по разделу 6: введённый текст, ожидаемый перевод и результат.
 */
export function feedbackText(
  feedback: AnswerFeedback,
  outcome: { becameHard?: boolean; word?: WordProgress } = {},
): string {
  const lines: string[] = [];
  if (feedback.typed) {
    lines.push(
      feedback.isCorrect ? "Верно." : "Неверно.",
      `Вы написали: ${clip(feedback.chosen, TYPED_ECHO_LIMIT)}`,
      `Ожидаемый перевод: ${feedback.typed.expected}`,
      pairText(feedback.card),
    );
  } else {
    const pair = pairText(feedback.card);
    lines.push(feedback.isCorrect ? `Верно: ${pair}` : `Вы выбрали ${feedback.chosen}; верно ${pair}`);
  }
  if (feedback.card.example) lines.push("", feedback.card.example);
  if (feedback.card.explanation) lines.push("", feedback.card.explanation);
  const progress = wordProgressText(outcome);
  if (progress) lines.push("", progress);
  return fitMessage(lines.join("\n"));
}

function wordProgressText({ becameHard = false, word }: { becameHard?: boolean; word?: WordProgress }): string | null {
  if (word?.transition === "returned_to_hard") return LEARNING_TEXTS.returnedToHard;
  if (becameHard) return LEARNING_TEXTS.becameHard;
  if (word?.transition === "mastered") return LEARNING_TEXTS.mastered;
  if (word?.countedInStreak) return `Серия «5 из 5»: ${word.correctStreak} из ${LEARNING_SETTINGS.masteryStreak}.`;
  if (word?.streakReset) return LEARNING_TEXTS.streakReset;
  return null;
}

const RESULT_TITLE = {
  test: "Тест завершён",
  translate: "«Переведи меня» завершено",
  hard_words: "Повторение сложных слов завершено",
  daily_quest: "Практика завершена",
  exam: "Экзамен завершён",
} as const;

export function resultText(result: SessionResult): string {
  const title = RESULT_TITLE[result.type];
  const lines = [result.title ? `${title}: ${result.title}` : title];
  if (result.answeredCount === 0) {
    lines.push("", "В этом занятии не было вопросов.");
    return fitMessage(lines.join("\n"));
  }
  lines.push(
    "",
    `С первой попытки: ${result.firstAttemptCorrect} из ${result.answeredCount}`,
    `После повтора: ${result.afterRepeatCorrect} из ${result.answeredCount}`,
    "",
  );
  const bullet = (pair: WordPair) => `• ${clip(pairText(pair), LIST_LINE_LIMIT)}`;
  // Экзамен: отдельно ошибки и пополнение «Сложных слов». Квест: слова для повтора (раздел 9 и 10 сценария).
  if (result.type === "exam" || result.type === "daily_quest") {
    if (result.mistakes.length > 0) {
      lines.push(result.type === "exam" ? "Ошибки:" : "Слова для повтора:", ...result.mistakes.map(bullet), "");
    } else {
      lines.push("Ошибок нет.", "");
    }
  }
  if (result.becameHard.length > 0) {
    lines.push(result.type === "exam" ? "Пополнили «Сложные слова»:" : "Стали сложными:", ...result.becameHard.map(bullet));
  } else if (result.type !== "hard_words") {
    lines.push("Новых сложных слов нет.");
  }
  if (result.mastered.length > 0) {
    if (lines.at(-1) !== "") lines.push("");
    lines.push("Освоены и ушли из «Сложных слов»:", ...result.mastered.map(bullet));
  }
  if ((result.type === "hard_words" || result.type === "daily_quest") && result.stillHard.length > 0) {
    if (lines.at(-1) !== "") lines.push("");
    lines.push(
      "Серия «5 из 5»:",
      ...result.stillHard.map((word) => `${bullet(word)}: ${word.correctStreak} из ${LEARNING_SETTINGS.masteryStreak}`),
    );
  }
  return fitMessage(lines.join("\n"));
}

export function resultKeyboard(type?: SessionResult["type"]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (type === "hard_words") keyboard.text("К сложным словам", hardWordsPage(0)).row();
  if (type === "daily_quest" || type === "exam") keyboard.text("Мой прогресс", PROGRESS_OPEN).row();
  return toMenu(keyboard);
}

// ---------- Сложные слова ----------

const hardLine = (word: HardWord, number: number) =>
  clip(
    `${number}. ${word.english} — ${word.translation} (${sourcesText(word.sources)}) · серия ${word.correctStreak} из ${LEARNING_SETTINGS.masteryStreak}`,
    LIST_LINE_LIMIT,
  );

/** Страница списка сложных слов. Её же бот использует, чтобы найти слова по маске из кнопки. */
export function hardWordsPageItems(words: readonly HardWord[], requestedPage: number) {
  const numbered = words.map((word, index) => ({ word, number: index + 1 }));
  const pages = paginate(numbered, ({ word, number }) => hardLine(word, number));
  const page = clampPage(requestedPage, pages.length);
  return { page, pageCount: pages.length, items: pages[page] ?? [] };
}

/** Слова страницы, отмеченные в маске. */
export function selectedHardWords(words: readonly HardWord[], page: number, mask: number): HardWord[] {
  const { page: actual, items } = hardWordsPageItems(words, page);
  if (actual !== page) return [];
  return items.filter((_, index) => (mask & (1 << index)) !== 0).map(({ word }) => word);
}

export function hardWordsScreen(screen: HardWordsScreen, requestedPage: number, requestedMask: number): Screen {
  const keyboard = new InlineKeyboard();
  if (screen.openSessionId !== null) keyboard.text("Продолжить повторение", resumeSession(screen.openSessionId)).row();
  if (screen.words.length === 0) return { text: LEARNING_TEXTS.noHardWords, keyboard: toMenu(keyboard) };

  const { page, pageCount, items } = hardWordsPageItems(screen.words, requestedPage);
  // Маска относится к странице, на которой её отметили.
  const mask = page === requestedPage ? requestedMask & ((1 << items.length) - 1) : 0;
  const selected = items.filter((_, index) => (mask & (1 << index)) !== 0).length;

  keyboard.text(`Повторить все (${screen.words.length})`, START_HARD_ALL).row();
  items.forEach(({ word, number }, index) => {
    const isSelected = (mask & (1 << index)) !== 0;
    keyboard.text(clip(`${isSelected ? "✓ " : ""}${number}. ${word.english}`, BUTTON_LABEL_LIMIT), hardWordsPage(page, mask ^ (1 << index)));
    if (index % 2 === 1 || index === items.length - 1) keyboard.row();
  });
  if (selected > 0) keyboard.text(`Повторить выбранные (${selected})`, startHardSelected(page, mask)).row();
  navigationRow(keyboard, page, pageCount, (target) => hardWordsPage(target));
  toMenu(keyboard);

  const lines = [
    `Сложные слова: ${screen.words.length}.`,
    `Слово уходит из списка после ${LEARNING_SETTINGS.masteryStreak} верных ответов подряд с первой попытки в разных занятиях.`,
    "",
    ...items.map(({ word, number }) => hardLine(word, number)),
    "",
    "Чтобы повторить только часть слов, отметьте их кнопками.",
  ];
  return { text: fitMessage(lines.join("\n")), keyboard };
}

export function staleScreen(stale: {
  sessionId: number;
  sessionStatus: "current" | "paused" | "completed" | "incomplete";
  hasState: boolean;
  saved: AnswerFeedback | null;
}): Screen & { callback: string } {
  const keyboard = new InlineKeyboard();
  if (stale.sessionStatus === "paused") {
    keyboard.text("Продолжить", resumeSession(stale.sessionId)).row();
    toMenu(keyboard);
    return { text: LEARNING_TEXTS.pausedMessage, keyboard, callback: LEARNING_TEXTS.pausedCallback };
  }
  const prefix = stale.saved ? feedbackText(stale.saved) : null;
  if (stale.sessionStatus === "current") {
    keyboard.text("Продолжить", resumeSession(stale.sessionId)).row();
    toMenu(keyboard);
    return {
      text: fitMessage(`${prefix ?? LEARNING_TEXTS.staleCallback}\n\nЗанятие продолжается: нажмите «Продолжить», чтобы увидеть текущий вопрос.`),
      keyboard,
      callback: stale.saved ? LEARNING_TEXTS.answeredCallback : LEARNING_TEXTS.staleCallback,
    };
  }
  if (stale.hasState) keyboard.text("Показать итог", resumeSession(stale.sessionId)).row();
  toMenu(keyboard);
  return {
    text: fitMessage(`${prefix ?? LEARNING_TEXTS.staleCallback}\n\n${LEARNING_TEXTS.finishedCallback}`),
    keyboard,
    callback: LEARNING_TEXTS.finishedCallback,
  };
}

