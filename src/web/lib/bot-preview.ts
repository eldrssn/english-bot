// Тексты бота для предпросмотра «глазами ученика». Повторяют src/bot/learning-render.ts и
// src/notifications/render.ts дословно: сам бот тянет grammY, поэтому в браузер его не взять.
// Совпадение проверяет test/web/bot-preview.test.ts — при правке текстов бота тест упадёт.
import type { CardContent } from "../../shared/api-contract.js";
import { buildChoiceOptions } from "../../domain/learning/choice-options.js";
import { createSeededRng } from "../../domain/learning/rng.js";
import type { AnswerCard, Direction } from "../../domain/learning/types.js";
import { promptText } from "../../domain/learning/types.js";

/** Как в learning-render.ts: длиннее — кнопки нумеруются, полный текст идёт в сообщении. */
export const BUTTON_LABEL_LIMIT = 40;

export const DIRECTION_HINT: Record<Direction, string> = {
  ru_en: "Выберите перевод на английский",
  en_ru: "Выберите перевод на русский",
};

export type PreviewCard = Pick<
  CardContent,
  "english" | "translation" | "example" | "explanation" | "acceptedRuEn" | "acceptedEnRu" | "allowOmitTo"
>;

export type BotScreen = { text: string; buttons: string[][] };

function clip(text: string, limit: number): string {
  const chars = [...text];
  return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join("")}…`;
}

const pairText = (card: { english: string; translation: string }) => `${card.english} — ${card.translation}`;

function contentLines(card: { english: string; translation: string; example: string | null; explanation: string | null }) {
  return [pairText(card), ...(card.example ? ["", card.example] : []), ...(card.explanation ? ["", card.explanation] : [])];
}

/** Карточка в разделе «Подборки» (collectionCardScreen). */
export function cardScreen(card: PreviewCard, neighbours: { previous: boolean; next: boolean }): BotScreen {
  const buttons: string[][] = [];
  const nav = [...(neighbours.previous ? ["← Предыдущая"] : []), ...(neighbours.next ? ["Следующая →"] : [])];
  if (nav.length > 0) buttons.push(nav);
  buttons.push(["К подборке", "В меню"]);
  return { text: contentLines(card).join("\n"), buttons };
}

/** Вопрос теста кнопками (questionScreen). */
export function questionScreen(question: { direction: Direction; prompt: string; options: string[]; number: number; total: number }): BotScreen {
  const needsFullText = question.options.some((option) => [...option].length > BUTTON_LABEL_LIMIT);
  const label = (option: string, index: number) => (needsFullText ? clip(`${index + 1}. ${option}`, BUTTON_LABEL_LIMIT) : option);
  const lines = [`Вопрос ${question.number} из ${question.total}`, "", `${DIRECTION_HINT[question.direction]}:`, question.prompt];
  if (needsFullText) lines.push("", ...question.options.map((option, index) => `${index + 1}. ${option}`));
  return { text: lines.join("\n"), buttons: [...question.options.map((option, index) => [label(option, index)]), ["На паузу"]] };
}

/** Ответ верный (feedbackText). */
export function correctFeedback(card: PreviewCard): string {
  const lines = [`Верно: ${pairText(card)}`];
  if (card.example) lines.push("", card.example);
  if (card.explanation) lines.push("", card.explanation);
  return lines.join("\n");
}

/** Слово нельзя проверить кнопками (skippedText). */
export const skippedText = (card: PreviewCard) =>
  `Слово «${clip(card.english, 100)}» пока нельзя проверить кнопками: не хватает других вариантов. Пропускаем его.`;

/** Уведомление «Новая подборка» (renderNotification, new_collection). */
export const newCollectionMessage = (title: string, wordCount: number) =>
  `Новая подборка: ${title || "без названия"}. Слов: ${wordCount}. Посмотрите карточки и начните практику.`;

/** Уведомление «В подборку добавлены слова» (renderNotification, collection_extended). */
export const collectionExtendedMessage = (title: string, addedCount: number) =>
  `В подборку добавлены слова: ${title || "без названия"}. Новых карточек: ${addedCount}. Посмотрите их и продолжите практику.`;

const toAnswerCard = (card: PreviewCard): AnswerCard => ({
  english: card.english,
  primaryTranslation: card.translation,
  acceptedRuEn: card.acceptedRuEn,
  acceptedEnRu: card.acceptedEnRu,
  allowOmitTo: card.allowOmitTo,
});

export type QuestionPreview =
  | { direction: Direction; available: true; screen: BotScreen; correctIndex: number }
  | { direction: Direction; available: false; text: string };

/**
 * Вопрос в обе стороны. Неверные варианты бот берёт из всех слов ученика, здесь — из других карточек
 * подборки, поэтому в боте варианты будут другими. Порядок постоянный, чтобы предпросмотр не прыгал.
 */
export function questionPreviews(card: PreviewCard, others: readonly PreviewCard[], position: { number: number; total: number }): QuestionPreview[] {
  const directions: Direction[] = ["ru_en", "en_ru"];
  return directions.map((direction, index) => {
    const built = buildChoiceOptions({
      card: toAnswerCard(card),
      direction,
      pool: others.map(toAnswerCard),
      rng: createSeededRng(17 + index),
    });
    if (!built.available) return { direction, available: false, text: skippedText(card) };
    const options = built.options.map((option) => option.text);
    return {
      direction,
      available: true,
      correctIndex: built.correctOptionIndex,
      screen: questionScreen({ direction, prompt: promptText(toAnswerCard(card), direction), options, ...position }),
    };
  });
}
