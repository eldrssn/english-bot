// Предпросмотр в кабинете повторяет тексты бота. Если бот поменяет формулировку, тест покажет расхождение.
import { describe, expect, it } from "vitest";
import { collectionCardScreen, feedbackText, questionScreen } from "../../src/bot/learning-render.js";
import { renderNotification } from "../../src/notifications/render.js";
import {
  cardScreen,
  collectionExtendedMessage,
  correctFeedback,
  newCollectionMessage,
  questionScreen as previewQuestion,
  typedFallbackScreen,
  type BotScreen,
} from "../../src/web/lib/bot-preview.js";

const card = {
  english: "to look forward to",
  translation: "ждать с нетерпением",
  example: "I look forward to the trip.",
  explanation: "После to идёт существительное или -ing.",
  acceptedRuEn: [],
  acceptedEnRu: [],
  allowOmitTo: true,
};

type Keyboard = { inline_keyboard: { text: string }[][] };
const labels = (keyboard: unknown) => (keyboard as Keyboard).inline_keyboard.map((row) => row.map((button) => button.text));

const expectSame = (preview: BotScreen, bot: { text: string; keyboard: unknown }) => {
  expect(preview.text).toBe(bot.text);
  expect(preview.buttons).toEqual(labels(bot.keyboard));
};

describe("предпросмотр глазами ученика совпадает с ботом", () => {
  it("карточка в подборке, с соседями и без", () => {
    for (const [previousCardId, nextCardId] of [
      [null, null],
      [1, null],
      [null, 2],
      [1, 2],
    ] as const) {
      const bot = collectionCardScreen(
        { card: { english: card.english, translation: card.translation, example: card.example, explanation: card.explanation }, collectionId: 1, previousCardId, nextCardId },
        0,
      );
      expectSame(cardScreen(card, { previous: previousCardId !== null, next: nextCardId !== null }), bot);
    }
    const bare = { ...card, example: null, explanation: null };
    expectSame(cardScreen(bare, { previous: false, next: false }), collectionCardScreen({ card: bare, collectionId: 1, previousCardId: null, nextCardId: null }, 0));
  });

  it("вопрос в обе стороны, короткие и длинные варианты", () => {
    const cases = [
      { direction: "ru_en" as const, prompt: "ждать", options: ["wait", "go", "to look forward to"] },
      { direction: "en_ru" as const, prompt: "bank", options: ["банк", "очень длинный вариант ответа, который не помещается на кнопку"] },
    ];
    for (const item of cases) {
      const bot = questionScreen({
        ...item,
        sessionId: 1,
        questionId: 1,
        attemptNumber: 1,
        isRepeat: false,
        format: "choice",
        typedFallback: false,
        number: 2,
        total: 7,
      });
      expectSame(previewQuestion({ ...item, number: 2, total: 7 }), bot);
    }
  });

  it("верный ответ и ввод вместо кнопок, когда неверных вариантов нет", () => {
    expect(correctFeedback(card)).toBe(feedbackText({ isCorrect: true, chosen: card.english, card }));
    for (const direction of ["ru_en", "en_ru"] as const) {
      const prompt = direction === "ru_en" ? card.translation : card.english;
      const bot = questionScreen({
        direction,
        prompt,
        options: [],
        sessionId: 1,
        questionId: 1,
        attemptNumber: 1,
        isRepeat: false,
        format: "typed",
        typedFallback: true,
        number: 1,
        total: 1,
      });
      expectSame(typedFallbackScreen({ direction, prompt, number: 1, total: 1 }), bot);
    }
  });

  it("уведомления о новой подборке и о добавленных словах", () => {
    expect(newCollectionMessage("Еда", 12)).toBe(renderNotification("new_collection", { title: "Еда", wordCount: 12 }));
    expect(collectionExtendedMessage("Еда", 3)).toBe(renderNotification("collection_extended", { title: "Еда", addedCount: 3 }));
  });
});
