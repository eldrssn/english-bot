// Типы повторяют значения schema.ts, но не импортируют Drizzle: домен не зависит от базы.

export type Direction = "ru_en" | "en_ru";
export type QuestionFormat = "choice" | "typed";
export type AttemptNumber = 1 | 2;

/** Содержимое карточки. Строка card_versions подходит без преобразований. */
export type AnswerCard = {
  english: string;
  primaryTranslation: string;
  /** Дополнительные ответы по-английски. */
  acceptedRuEn: readonly string[];
  /** Дополнительные ответы по-русски. */
  acceptedEnRu: readonly string[];
  allowOmitTo: boolean;
};

/** Текст, который бот показывает в вопросе. */
export function promptText(card: AnswerCard, direction: Direction): string {
  return direction === "ru_en" ? card.primaryTranslation : card.english;
}

/** Основной верный ответ для показа. */
export function primaryAnswerText(card: AnswerCard, direction: Direction): string {
  return direction === "ru_en" ? card.english : card.primaryTranslation;
}

export function oppositeDirection(direction: Direction): Direction {
  return direction === "ru_en" ? "en_ru" : "ru_en";
}
