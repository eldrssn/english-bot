import { normalizeAnswerText } from "../normalize.js";
import { checkAnswer } from "./answer-check.js";
import { shuffled, type Rng } from "./rng.js";
import { LEARNING_SETTINGS } from "./settings.js";
import { oppositeDirection, primaryAnswerText, promptText, type AnswerCard, type Direction } from "./types.js";

export type ChoiceOptionsInput = {
  /** Версия карточки, по которой задан вопрос: из неё берётся верный вариант. */
  card: AnswerCard;
  /** Другие действующие карточки того же слова: их допустимые ответы тоже не попадут в неверные. */
  sameWordCards?: readonly AnswerCard[];
  direction: Direction;
  /** Карточки, из которых подбираются неверные варианты. */
  pool: readonly AnswerCard[];
  rng: Rng;
  optionCount?: number;
};

export type ChoiceOptions =
  | {
      available: true;
      /**
       * Полный текст вариантов без обрезки, форма совпадает с questions.options.
       * Как показать длинную фразу на кнопке, решает бот.
       */
      options: { text: string }[];
      correctOptionIndex: number;
    }
  /** Неверных вариантов нет: тест по этому слову недоступен, бот предлагает «Переведи меня». */
  | { available: false; reason: "no_distractors" };

/**
 * Варианты для кнопок: один верный и до optionCount − 1 неверных из других слов.
 *
 * Кандидат отбрасывается, если он:
 * - был бы принят как верный ответ текущего слова;
 * - совпадает с уже выбранным неверным, в том числе с точностью до начального `to`;
 * - настоящий перевод показанного текста, то есть показанный текст допустим для его карточки
 *   в обратном направлении. На вопрос «bank» вариант «берег» из `bank — берег` был бы верным по сути,
 *   хотя считался бы ошибкой.
 */
export function buildChoiceOptions(input: ChoiceOptionsInput): ChoiceOptions {
  const { card, sameWordCards = [], direction, pool, rng } = input;
  const optionCount = input.optionCount ?? LEARNING_SETTINGS.choiceOptionCount;
  const currentCards = [card, ...sameWordCards];
  const prompt = promptText(card, direction);

  const distractors: string[] = [];
  const seen = new Set<string>();
  for (const candidate of shuffled(pool, rng)) {
    if (distractors.length >= optionCount - 1) break;
    const text = primaryAnswerText(candidate, direction);
    // Для английских вариантов сравнение без начального `to`: `to go` и `go` — один вариант.
    const key = normalizeAnswerText(text, { allowOmitTo: direction === "ru_en" });
    if (key === "" || seen.has(key)) continue;
    if (checkAnswer(currentCards, direction, text).isCorrect) continue;
    if (checkAnswer([candidate], oppositeDirection(direction), prompt).isCorrect) continue;
    seen.add(key);
    distractors.push(text);
  }

  if (distractors.length === 0) return { available: false, reason: "no_distractors" };

  const correctText = primaryAnswerText(card, direction);
  const order = shuffled(
    [
      { text: correctText, isCorrect: true },
      ...distractors.map((text) => ({ text, isCorrect: false })),
    ],
    rng,
  );
  return {
    available: true,
    options: order.map(({ text }) => ({ text })),
    correctOptionIndex: order.findIndex((option) => option.isCorrect),
  };
}
