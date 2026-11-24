// Карточка из импорта или ручного ввода: подготовка и проверка.
// Модуль работает и в браузере, и на сервере: только чистый TypeScript, без Node API и DOM.
import { normalizeAnswerText, normalizeWordText } from "../../domain/normalize.js";

export type ImportedCard = {
  english: string;
  translation: string;
  example: string | null;
  explanation: string | null;
  /** Дополнительные ответы для направления ru→en (по-английски). */
  acceptedRuEn: string[];
  /** Дополнительные ответы для направления en→ru (по-русски). */
  acceptedEnRu: string[];
  allowOmitTo: boolean;
};

/**
 * Длины в символах (кодовых точках). Слово и вариант ответа должны помещаться на кнопку Telegram
 * без потери смысла; окончательную обрезку для кнопки делает бот, поэтому лимиты нестрогие.
 */
export const CARD_LIMITS = {
  english: 100,
  translation: 100,
  example: 500,
  explanation: 500,
  acceptedItem: 100,
  acceptedCount: 20,
} as const satisfies Record<string, number>;

export type CardInput = {
  english: string;
  translation: string;
  example?: string | null;
  explanation?: string | null;
  acceptedRuEn?: readonly string[] | string;
  acceptedEnRu?: readonly string[] | string;
  allowOmitTo?: boolean;
};

/** Однострочные поля: обрезка по краям и один пробел вместо любой серии пробелов и переносов. */
function cleanLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cleanText(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/** Есть ли в начале английского текста `to ` с чем-то после него (`to go`, но не просто `to`). */
export function startsWithTo(english: string): boolean {
  return /^to \S/.test(normalizeWordText(english));
}

/**
 * Дополнительные ответы: разбить по «;», обрезать, убрать пустые, повторы и совпадающие
 * с основным значением. Сравнение — как при проверке ответа ученика (`normalizeAnswerText`).
 */
export function cleanAcceptedAnswers(
  items: readonly string[] | string,
  main: string,
  options: { allowOmitTo?: boolean } = {},
): string[] {
  const list = typeof items === "string" ? items.split(";") : items.flatMap((item) => item.split(";"));
  const seen = new Set<string>();
  const mainKey = normalizeAnswerText(main, options);
  if (mainKey) seen.add(mainKey);
  const result: string[] = [];
  for (const raw of list) {
    const item = cleanLine(raw);
    const key = normalizeAnswerText(item, options);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/** Приводит ввод к виду, который сохраняется: обрезка, null вместо пустых, очистка вариантов. */
export function prepareCard(input: CardInput): ImportedCard {
  const english = cleanLine(input.english);
  const translation = cleanLine(input.translation);
  const allowOmitTo = input.allowOmitTo ?? false;
  return {
    english,
    translation,
    example: cleanText(input.example),
    explanation: cleanText(input.explanation),
    // ru→en сравнивается с английским словом с учётом разрешения пропускать `to`.
    acceptedRuEn: cleanAcceptedAnswers(input.acceptedRuEn ?? [], english, { allowOmitTo }),
    acceptedEnRu: cleanAcceptedAnswers(input.acceptedEnRu ?? [], translation),
    allowOmitTo,
  };
}

const length = (value: string) => [...value].length;

function quote(value: string, max = 40): string {
  const chars = [...value];
  return `«${chars.length > max ? chars.slice(0, max).join("") + "…" : value}»`;
}

function checkLength(errors: string[], value: string | null, limit: number, what: string) {
  if (value === null) return;
  const actual = length(value);
  if (actual > limit) errors.push(`${what} длиннее ${limit} символов (сейчас ${actual})`);
}

function checkAccepted(errors: string[], items: readonly string[], direction: string) {
  if (items.length > CARD_LIMITS.acceptedCount) {
    errors.push(
      `дополнительных ответов ${direction} больше ${CARD_LIMITS.acceptedCount} (сейчас ${items.length})`,
    );
  }
  for (const item of items) {
    if (item.trim() === "") {
      errors.push(`среди дополнительных ответов ${direction} есть пустой`);
    } else if (length(item) > CARD_LIMITS.acceptedItem) {
      errors.push(
        `дополнительный ответ ${direction} ${quote(item)} длиннее ${CARD_LIMITS.acceptedItem} символов (сейчас ${length(item)})`,
      );
    }
  }
}

/**
 * Правила карточки, общие для импорта и ручного ввода в редакторе. Возвращает понятные
 * преподавателю ошибки по-русски, без номера строки; пустой массив — карточка годится.
 * Ожидает карточку после `prepareCard` (лишние пробелы и повторы вариантов там уже убраны).
 */
export function validateCard(card: ImportedCard): string[] {
  const errors: string[] = [];
  if (normalizeWordText(card.english) === "") errors.push("нет слова или фразы по-английски");
  if (normalizeWordText(card.translation) === "") errors.push("нет перевода");
  checkLength(errors, card.english, CARD_LIMITS.english, "слово или фраза");
  checkLength(errors, card.translation, CARD_LIMITS.translation, "перевод");
  checkLength(errors, card.example, CARD_LIMITS.example, "пример");
  checkLength(errors, card.explanation, CARD_LIMITS.explanation, "пояснение");
  checkAccepted(errors, card.acceptedRuEn, "ru→en");
  checkAccepted(errors, card.acceptedEnRu, "en→ru");
  if (card.allowOmitTo && card.english.trim() !== "" && !startsWithTo(card.english)) {
    errors.push(
      `отмечено «можно без to», но ${quote(card.english)} не начинается с «to »: ` +
        "пропуск to подходит только для глаголов вида «to go»",
    );
  }
  return errors;
}
