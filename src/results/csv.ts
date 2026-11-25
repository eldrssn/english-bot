// Выгрузка результатов ученика в CSV для Excel и Google Таблиц.
//
// - Кодировка UTF-8 с BOM: без него Excel в Windows открывает русский текст «кракозябрами».
// - Разделитель «;»: Excel с русскими региональными настройками разбивает по нему столбцы при открытии файла
//   двойным щелчком; Google Таблицы определяют его сами. Строки разделяются CRLF.
// - Защита от формул (CSV injection): значение, которое таблица приняла бы за формулу, начинается с апострофа.
//   Опасны первые символы =, +, -, @, а также табуляция и перевод строки (OWASP «CSV Injection»).
//   Слово, перевод и ответ ученика — пользовательский текст, поэтому защищаются все строковые значения.
import { LEARNING_SETTINGS } from "../domain/learning/settings.js";
import type { ResultAnswer, ResultSession, Score, SessionKind, StudentResults, WordState } from "../shared/api-contract.js";

export const CSV_BOM = "﻿";
export const CSV_DELIMITER = ";";
const LINE_END = "\r\n";

const FORMULA_START = /^[=+\-@\t\r\n]/;

export type CsvValue = string | number | boolean | null | undefined;

/** Значение ячейки: строка с опасным началом получает апостроф, затем всё кавычится по правилам RFC 4180. */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  // Числа и логические значения формируем сами: формулой они быть не могут (отрицательных чисел в выгрузке нет).
  let text = typeof value === "string" ? value : String(value);
  if (typeof value === "string" && FORMULA_START.test(text)) text = `'${text}`;
  return /[";\r\n,]|^\s|\s$/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvRow(values: readonly CsvValue[]): string {
  return values.map(csvCell).join(CSV_DELIMITER);
}

/** Файл целиком: BOM, строки через CRLF, перевод строки в конце. */
export function csvDocument(rows: readonly (readonly CsvValue[])[]): string {
  return CSV_BOM + rows.map(csvRow).join(LINE_END) + LINE_END;
}

const SESSION_LABEL: Record<SessionKind, string> = {
  test: "Тест",
  translate: "Переведи меня",
  hard_words: "Практика сложных слов",
  daily_quest: "Ежедневный квест",
  exam: "Экзамен",
};

const SESSION_STATUS_LABEL: Record<ResultSession["status"], string> = {
  current: "Идёт",
  paused: "На паузе",
  completed: "Завершено",
  incomplete: "Не завершено",
};

const WORD_STATUS_LABEL: Record<WordState, string> = { learning: "Изучается", hard: "Сложное", mastered: "Освоено" };

const COLLECTION_STATUS_LABEL = { assigned: "Назначено", started: "Начал", practicing: "Практикует", completed: "Завершил" };

const DIRECTION_LABEL: Record<ResultAnswer["direction"], string> = { ru_en: "ru→en", en_ru: "en→ru" };
const FORMAT_LABEL: Record<ResultAnswer["format"], string> = { choice: "Кнопки", typed: "Ввод" };

const yesNo = (value: boolean) => (value ? "да" : "нет");
const scoreText = (score: Score) => `${score.correct} из ${score.total}`;

/** «2026-11-24 18:05» в часовом поясе ученика (или UTC): такой текст Excel распознаёт как дату и время. */
export function formatCsvDate(iso: string | null, timeZone: string): string {
  if (!iso) return "";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/**
 * Один файл с разделами: сводка, подборки, занятия, ответы (обе попытки), слова и просмотры.
 * Разделы разделены пустой строкой и начинаются строкой-заголовком, чтобы файл читался и глазами, и фильтром.
 */
export function studentResultsCsv(results: StudentResults): string {
  const timeZone = results.student.timezone ?? "UTC";
  const date = (iso: string | null) => formatCsvDate(iso, timeZone);
  const sessionTitle = (type: SessionKind, title: string | null) => (title ? `${SESSION_LABEL[type]}: ${title}` : SESSION_LABEL[type]);
  const { progress, totals } = results;
  const rows: CsvValue[][] = [
    ["Результаты ученика", results.student.displayName],
    ["Выгружено", date(results.generatedAt)],
    ["Часовой пояс дат", timeZone],
    ["Подключён", date(results.student.startedAt)],
    [],
    ["Сводка"],
    ["Доступно слов", progress.available],
    ["Изучено слов", progress.studied],
    ["Сложных слов", progress.hard],
    ["Освоено слов", progress.mastered],
    ["Завершено подборок", `${progress.completedCollections} из ${progress.totalCollections}`],
    ["Серия дней с квестом", progress.questStreak],
    ["Завершено квестов", progress.questsCompleted],
    ["Завершено экзаменов", progress.examsCompleted],
    ["Отвечено вопросов", totals.answered],
    ["Верно с первой попытки", scoreText(totals.firstAttempt)],
    ["Верно после повтора", scoreText(totals.afterRepeat)],
    [],
    ["Подборки"],
    ["Подборка", "Статус", "Выдана", "Слов", "Просмотрено карточек", "Отвечено слов", "Верно с первой попытки"],
    ...results.collections.map((collection) => [
      collection.title,
      COLLECTION_STATUS_LABEL[collection.status],
      date(collection.publishedAt),
      collection.wordCount,
      collection.viewedCards,
      collection.answeredWords,
      scoreText(collection.firstAttempt),
    ]),
    [],
    ["Занятия"],
    ["Начато", "Завершено", "Занятие", "Дата квеста", "Статус", "Вопросов", "Отвечено", "Верно с первой попытки", "Верно после повтора", "Стали сложными", "Освоены"],
    ...results.sessions.map((session) => [
      date(session.startedAt),
      date(session.finishedAt),
      sessionTitle(session.type, session.title),
      session.questLocalDate ?? "",
      SESSION_STATUS_LABEL[session.status],
      session.plannedCount,
      session.answeredCount,
      scoreText(session.firstAttempt),
      scoreText(session.afterRepeat),
      session.becameHard,
      session.mastered,
    ]),
    [],
    ["Ответы"],
    [
      "Время",
      "Занятие",
      "Слово",
      "Перевод",
      "Направление",
      "Формат",
      "Ответ с первой попытки",
      "Верно с первой попытки",
      "Ответ на повторе",
      "Верно на повторе",
      "Стало сложным",
      "Освоено",
    ],
    ...results.answers.map((answer) => [
      date(answer.first.answeredAt),
      SESSION_LABEL[answer.sessionType],
      answer.english,
      answer.translation,
      DIRECTION_LABEL[answer.direction],
      FORMAT_LABEL[answer.format],
      answer.first.answer,
      yesNo(answer.first.correct),
      answer.second?.answer ?? "",
      answer.second ? yesNo(answer.second.correct) : "",
      yesNo(answer.becameHard),
      yesNo(answer.becameMastered),
    ]),
    [],
    ["Слова"],
    ["Слово", "Перевод", "Состояние", "Серия «5 из 5»", "Подборки", "Верно с первой попытки", "Последний ответ"],
    ...results.words.map((word) => [
      word.english,
      word.translation,
      WORD_STATUS_LABEL[word.status],
      `${word.correctStreak} из ${LEARNING_SETTINGS.masteryStreak}`,
      word.sources.join(", "),
      scoreText(word.firstAttempt),
      date(word.lastAnsweredAt),
    ]),
    [],
    ["Просмотренные карточки"],
    ["Слово", "Перевод", "Подборка", "Просмотров", "Последний просмотр"],
    ...results.views.map((view) => [view.english, view.translation, view.collectionTitle, view.views, date(view.lastViewedAt)]),
  ];
  return csvDocument(rows);
}

/** Имя файла: латиница для старых программ и полное имя в filename* (RFC 6266 и RFC 5987). */
export function csvContentDisposition(displayName: string, generatedAt: string): string {
  const day = generatedAt.slice(0, 10);
  const ascii = `results-${day}.csv`;
  const safeName = displayName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").trim().slice(0, 80) || "ученик";
  const full = `Результаты ${safeName} ${day}.csv`;
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(full)}`;
}
