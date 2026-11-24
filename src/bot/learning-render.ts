// Тексты и разметка учебных разделов. Без обращений к базе и Telegram.
import { InlineKeyboard } from "grammy";
import type {
  AnswerFeedback,
  AskedQuestion,
  CollectionCardScreen,
  CollectionScreen,
  OpenSession,
  SessionResult,
  WordPair,
} from "../learning/service.js";
import type { VisibleCollection, VocabularyWord } from "../learning/vocabulary.js";
import {
  MENU,
  answerButton,
  collectionCard,
  collectionPage,
  collectionsPage,
  pauseSession,
  resumeSession,
  soonButton,
  startTest,
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
  soon: "Этот раздел появится позже",
  help: "Выберите раздел в меню. Тест проходит кнопками, прерванное занятие можно продолжить из меню.",
  noOpenQuestionHint: "Сейчас ответ выбирается кнопкой под вопросом. Чтобы вернуться к нему, нажмите «Продолжить».",
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
    keyboard.text(clip(`Продолжить: ${session.title ?? "занятие"}`, BUTTON_LABEL_LIMIT), resumeSession(session.sessionId)).row();
  }
  return keyboard
    .text("Все слова", wordsPage(0))
    .text("Подборки", collectionsPage(0))
    .row()
    .text("Сложные слова", soonButton("hard"))
    .text("Ежедневная практика", soonButton("daily"))
    .row()
    .text("Экзамен", soonButton("exam"))
    .text("Мой прогресс", soonButton("progress"))
    .row()
    .text("Настройки", soonButton("settings"));
}

export const soonKeyboard = () => toMenu(new InlineKeyboard());

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
  const { collection, cards, openSessionId } = screen;
  const line = (card: CollectionCardItem, number: number) => {
    const mark = card.isNew ? ` [новая, ${formatDate(card.addedAt, timezone)}]` : "";
    return clip(`${number}. ${card.version.english} — ${card.version.primaryTranslation}${mark}`, LIST_LINE_LIMIT);
  };
  const numbered = cards.map((card, index) => ({ card, number: index + 1 }));
  const pages = paginate(numbered, ({ card, number }) => line(card, number));
  const page = clampPage(requestedPage, pages.length);
  const items = pages[page] ?? [];

  const keyboard = new InlineKeyboard();
  if (openSessionId !== null) keyboard.text("Продолжить тест", resumeSession(openSessionId)).row();
  else if (cards.length > 0) keyboard.text("Начать тест", startTest(collection.id)).row();
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

/**
 * Длинный вариант на кнопке обрезается. Обрезка могла бы сделать варианты неразличимыми, поэтому при любой обрезке
 * кнопки нумеруются, а полный текст всех вариантов идёт в сообщении.
 */
export function questionScreen(question: AskedQuestion): Screen {
  const needsFullText = question.options.some((option) => [...option].length > BUTTON_LABEL_LIMIT);
  const label = (option: string, index: number) =>
    needsFullText ? clip(`${index + 1}. ${option}`, BUTTON_LABEL_LIMIT) : option;

  const keyboard = new InlineKeyboard();
  question.options.forEach((option, index) => {
    keyboard.text(label(option, index), answerButton(question.questionId, question.attemptNumber, index)).row();
  });
  keyboard.text("На паузу", pauseSession(question.sessionId));

  const header = question.isRepeat ? "Повтор ошибки" : `Вопрос ${question.number} из ${question.total}`;
  const lines = [header, "", `${DIRECTION_HINT[question.direction]}:`, question.prompt];
  if (needsFullText) lines.push("", ...question.options.map((option, index) => `${index + 1}. ${option}`));
  return { text: fitMessage(lines.join("\n")), keyboard };
}

/** Дословно по разделу 5 сценария: «Верно» и пара; «Вы выбрали …; верно …». */
export function feedbackText(feedback: AnswerFeedback, becameHard = false): string {
  const pair = pairText(feedback.card);
  const verdict = feedback.isCorrect ? `Верно: ${pair}` : `Вы выбрали ${feedback.chosen}; верно ${pair}`;
  const lines = [verdict];
  if (feedback.card.example) lines.push("", feedback.card.example);
  if (feedback.card.explanation) lines.push("", feedback.card.explanation);
  if (becameHard) lines.push("", LEARNING_TEXTS.becameHard);
  return fitMessage(lines.join("\n"));
}

export function resultText(result: SessionResult): string {
  const lines = [result.title ? `Тест завершён: ${result.title}` : "Тест завершён"];
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
  if (result.becameHard.length > 0) {
    lines.push("Стали сложными:", ...result.becameHard.map((pair) => `• ${clip(pairText(pair), LIST_LINE_LIMIT)}`));
  } else {
    lines.push("Новых сложных слов нет.");
  }
  return fitMessage(lines.join("\n"));
}

export const resultKeyboard = () => toMenu(new InlineKeyboard());

export const skippedText = (skipped: readonly WordPair[]) =>
  fitMessage(
    skipped
      .map((pair) => `Слово «${clip(pair.english, 100)}» пока нельзя проверить кнопками: не хватает других вариантов. Пропускаем его.`)
      .join("\n"),
  );

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

