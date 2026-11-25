import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeWordKey, sameWord } from "../../../src/domain/index.js";
import { checkAnswer, isBlankAnswer, type Direction } from "../../../src/domain/learning/index.js";
import { card, fixtureCards } from "./fixtures.js";

type AnswerRow = {
  english: string;
  translation: string;
  direction: Direction;
  input: string;
  expected: boolean;
  note: string;
};

const { answers } = JSON.parse(readFileSync("fixtures/expected-results.json", "utf8")) as { answers: AnswerRow[] };

describe("checkAnswer: таблица ожидаемых результатов", () => {
  it("таблица не пуста", () => {
    expect(answers.length).toBeGreaterThan(60);
  });

  it.each(answers)("$english — $translation, $direction: «$input» → $expected ($note)", (row) => {
    const key = makeWordKey(row.english, row.translation);
    const cards = fixtureCards.filter((item) => sameWord(makeWordKey(item.english, item.primaryTranslation), key));
    expect(cards.length).toBeGreaterThan(0);
    expect(checkAnswer(cards, row.direction, row.input).isCorrect).toBe(row.expected);
  });
});

describe("checkAnswer: несколько карточек одного слова", () => {
  const strict = card("to go", "идти", { acceptedRuEn: ["to walk"], acceptedEnRu: ["шагать"], allowOmitTo: false });
  const lenient = card("to go", "идти", { acceptedRuEn: ["to move"], acceptedEnRu: ["ехать"], allowOmitTo: true });

  it("верен ответ из любой карточки и сообщается, какая совпала", () => {
    expect(checkAnswer([strict, lenient], "ru_en", "to walk")).toEqual({ isCorrect: true, matchedCardIndex: 0 });
    expect(checkAnswer([strict, lenient], "ru_en", "to move")).toEqual({ isCorrect: true, matchedCardIndex: 1 });
    expect(checkAnswer([strict, lenient], "en_ru", "ехать")).toEqual({ isCorrect: true, matchedCardIndex: 1 });
  });

  it("to пропускается только в карточке, где это разрешено", () => {
    expect(checkAnswer([strict, lenient], "ru_en", "move").isCorrect).toBe(true);
    expect(checkAnswer([strict, lenient], "ru_en", "go").isCorrect).toBe(true);
    // Разрешение второй карточки не распространяется на вариант первой.
    expect(checkAnswer([strict, lenient], "ru_en", "walk").isCorrect).toBe(false);
    expect(checkAnswer([lenient, strict], "ru_en", "walk").isCorrect).toBe(false);
  });

  it("одна карточка без разрешения не принимает ответ без to", () => {
    expect(checkAnswer([strict], "ru_en", "go")).toEqual({ isCorrect: false, matchedCardIndex: null });
  });

  it("разрешение пропустить to не работает для русского ответа", () => {
    const withToVariant = card("to go", "идти", { acceptedEnRu: ["to идти"], allowOmitTo: true });
    expect(checkAnswer([withToVariant], "en_ru", "to идти").isCorrect).toBe(true);
    expect(checkAnswer([card("to go", "идти", { allowOmitTo: true })], "en_ru", "to идти").isCorrect).toBe(false);
  });

  it("нет карточек: ответ неверен", () => {
    expect(checkAnswer([], "ru_en", "go").isCorrect).toBe(false);
  });

  it("пустой ответ не совпадает с вариантом из одной пунктуации", () => {
    const odd = card("go", "идти", { acceptedRuEn: ["?!"] });
    expect(checkAnswer([odd], "ru_en", "!!").isCorrect).toBe(false);
    expect(checkAnswer([odd], "ru_en", "").isCorrect).toBe(false);
  });
});

describe("isBlankAnswer: текст без слов попыткой не считается", () => {
  it.each(["", "   ", "?!", "...", "👍", "—", "\u200b"])("«%s» пустой", (input) => {
    expect(isBlankAnswer(input)).toBe(true);
  });

  it.each(["to", "0", "a", "е", "не"])("«%s» — ответ", (input) => {
    expect(isBlankAnswer(input)).toBe(false);
  });
});
