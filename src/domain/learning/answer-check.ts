import { normalizeAnswerText } from "../normalize.js";
import { type AnswerCard, type Direction } from "./types.js";

export type AnswerCheck = {
  isCorrect: boolean;
  /** Индекс карточки, с которой совпал ответ. Пусто при неверном ответе. */
  matchedCardIndex: number | null;
};

/**
 * Проверка ответа: совпадение после нормализации с основным значением или допустимым вариантом
 * нужного направления. Допуска к опечаткам нет.
 *
 * `cards` — карточки, по которым принимается ответ: версия заданного вопроса (раздел 8 сценария)
 * и действующие карточки того же слова. Каждая проверяется отдельно: разрешение пропустить `to`
 * действует только на варианты своей карточки, поэтому объединять варианты в один список нельзя.
 * Сам `to` бывает только в английском ответе, для en_ru разрешение не применяется.
 */
export function checkAnswer(cards: readonly AnswerCard[], direction: Direction, input: string): AnswerCheck {
  const matchedCardIndex = cards.findIndex((card) => matchesCard(card, direction, input));
  return matchedCardIndex === -1 ? { isCorrect: false, matchedCardIndex: null } : { isCorrect: true, matchedCardIndex };
}

function matchesCard(card: AnswerCard, direction: Direction, input: string): boolean {
  const allowOmitTo = direction === "ru_en" && card.allowOmitTo;
  const answer = normalizeAnswerText(input, { allowOmitTo });
  if (answer === "") return false;
  const variants =
    direction === "ru_en" ? [card.english, ...card.acceptedRuEn] : [card.primaryTranslation, ...card.acceptedEnRu];
  return variants.some((variant) => normalizeAnswerText(variant, { allowOmitTo }) === answer);
}
