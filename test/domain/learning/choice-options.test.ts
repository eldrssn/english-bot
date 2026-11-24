import { describe, expect, it } from "vitest";
import { normalizeAnswerText } from "../../../src/domain/index.js";
import {
  buildChoiceOptions,
  checkAnswer,
  createSeededRng,
  type ChoiceOptions,
  type Direction,
} from "../../../src/domain/learning/index.js";
import { card, fixtureCards } from "./fixtures.js";

const fast = card("fast", "быстрый", { acceptedRuEn: ["quick"], acceptedEnRu: ["скорый"] });
const pool = [
  card("slow", "медленный"),
  card("big", "большой"),
  card("small", "маленький"),
  card("old", "старый"),
  card("new", "новый"),
];

function available(result: ChoiceOptions) {
  if (!result.available) throw new Error("тест должен быть доступен");
  return result;
}

const texts = (result: ChoiceOptions) => available(result).options.map((option) => option.text);

describe("buildChoiceOptions", () => {
  it("4 варианта: один верный и три неверных", () => {
    const result = available(buildChoiceOptions({ card: fast, direction: "ru_en", pool, rng: createSeededRng(1) }));
    expect(result.options).toHaveLength(4);
    expect(result.options[result.correctOptionIndex]?.text).toBe("fast");
    expect(result.options.filter((option) => option.text === "fast")).toHaveLength(1);
  });

  it("в en_ru на кнопках русские переводы", () => {
    const result = available(buildChoiceOptions({ card: fast, direction: "en_ru", pool, rng: createSeededRng(1) }));
    expect(result.options[result.correctOptionIndex]?.text).toBe("быстрый");
    expect(result.options.every((option) => /[а-я]/.test(option.text))).toBe(true);
  });

  it("верный вариант не стоит всегда на одном месте", () => {
    const indexes = new Set(
      Array.from({ length: 50 }, (_, seed) => {
        const rng = createSeededRng(seed);
        return available(buildChoiceOptions({ card: fast, direction: "ru_en", pool, rng })).correctOptionIndex;
      }),
    );
    expect(indexes.size).toBe(4);
  });

  it("один seed даёт одинаковые варианты, разные seed — разные", () => {
    const run = (seed: number) => buildChoiceOptions({ card: fast, direction: "ru_en", pool, rng: createSeededRng(seed) });
    expect(run(42)).toEqual(run(42));
    const distinct = new Set(Array.from({ length: 20 }, (_, seed) => JSON.stringify(run(seed))));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it("неверные варианты выбираются из всего пула, а не только из его начала", () => {
    const shown = new Set<string>();
    for (let seed = 0; seed < 50; seed++) {
      const result = buildChoiceOptions({ card: fast, direction: "ru_en", pool, rng: createSeededRng(seed) });
      texts(result).forEach((text) => shown.add(text));
    }
    expect([...shown].sort()).toEqual(["big", "fast", "new", "old", "slow", "small"]);
  });

  it("при нехватке показывает сколько есть", () => {
    const two = buildChoiceOptions({ card: fast, direction: "ru_en", pool: pool.slice(0, 2), rng: createSeededRng(3) });
    expect(texts(two).sort()).toEqual(["big", "fast", "slow"]);
    const one = buildChoiceOptions({ card: fast, direction: "ru_en", pool: pool.slice(0, 1), rng: createSeededRng(3) });
    expect(texts(one).sort()).toEqual(["fast", "slow"]);
  });

  it("без неверных вариантов сообщает о недоступности и не бросает исключение", () => {
    const expected = { available: false, reason: "no_distractors" };
    const rng = createSeededRng(1);
    expect(buildChoiceOptions({ card: fast, direction: "ru_en", pool: [], rng })).toEqual(expected);
    expect(buildChoiceOptions({ card: fast, direction: "ru_en", pool: [fast], rng })).toEqual(expected);
  });

  it("допустимые ответы текущего слова не попадают в неверные, в том числе из другой карточки", () => {
    const sameWordCards = [card("fast", "быстрый", { acceptedRuEn: ["rapid"] })];
    const tricky = [card("quick", "сообразительный"), card("rapid", "порог"), card("Fast!", "пост"), card("slow", "медленный")];
    for (let seed = 0; seed < 30; seed++) {
      const result = buildChoiceOptions({ card: fast, sameWordCards, direction: "ru_en", pool: tricky, rng: createSeededRng(seed) });
      expect(texts(result).sort()).toEqual(["fast", "slow"]);
    }
  });

  it("учитывает разрешённый пропуск to: `go` не будет неверным вариантом для `to go`", () => {
    const toGo = card("to go", "идти", { allowOmitTo: true });
    const result = buildChoiceOptions({ card: toGo, direction: "ru_en", pool: [card("go", "движение"), card("slow", "медленный")], rng: createSeededRng(1) });
    expect(texts(result).sort()).toEqual(["slow", "to go"]);
  });

  it("неверные варианты не совпадают друг с другом после нормализации", () => {
    const dup = [card("Slow.", "а"), card("slow", "б"), card(" SLOW ", "в"), card("to slow", "г"), card("big", "д")];
    for (let seed = 0; seed < 30; seed++) {
      const result = available(buildChoiceOptions({ card: fast, direction: "ru_en", pool: dup, rng: createSeededRng(seed) }));
      const keys = result.options.map((option) => normalizeAnswerText(option.text, { allowOmitTo: true }));
      expect(new Set(keys).size).toBe(keys.length);
      expect(result.options).toHaveLength(3);
    }
  });

  it("совпадающие переводы: перевод другого слова не становится неверным вариантом", () => {
    const big = card("big", "большой");
    const large = card("large", "большой");
    // en_ru: «большой» — верный ответ текущего слова.
    const enRu = buildChoiceOptions({ card: big, direction: "en_ru", pool: [large, card("old", "старый")], rng: createSeededRng(1) });
    expect(texts(enRu).sort()).toEqual(["большой", "старый"]);
    // ru_en: на вопрос «большой» кнопка `large` тоже была бы верной по сути.
    const ruEn = buildChoiceOptions({ card: big, direction: "ru_en", pool: [large, card("old", "старый")], rng: createSeededRng(1) });
    expect(texts(ruEn).sort()).toEqual(["big", "old"]);
  });

  it("многозначное слово: другое значение того же английского не становится неверным вариантом", () => {
    const shore = card("bank", "берег");
    const money = card("bank", "банк");
    const rng = createSeededRng(1);
    expect(buildChoiceOptions({ card: money, direction: "en_ru", pool: [shore], rng }).available).toBe(false);
    expect(buildChoiceOptions({ card: money, direction: "ru_en", pool: [shore], rng }).available).toBe(false);
  });

  it("длинная фраза отдаётся полностью, без обрезки и нормализации", () => {
    const long = "Could you please tell me how to get to the nearest railway station, sir?";
    const phrase = card(long, "Как пройти к вокзалу?");
    const result = available(buildChoiceOptions({ card: phrase, direction: "ru_en", pool: [card(`${long} Now!`, "другое")], rng: createSeededRng(1) }));
    expect(result.options[result.correctOptionIndex]?.text).toBe(long);
    expect(result.options.map((option) => option.text)).toContain(`${long} Now!`);
  });

  it("настоящие подборки: ни один неверный вариант не принимается как верный", () => {
    const directions: Direction[] = ["ru_en", "en_ru"];
    fixtureCards.forEach((current, index) => {
      for (const direction of directions) {
        const result = available(buildChoiceOptions({ card: current, direction, pool: fixtureCards, rng: createSeededRng(index) }));
        expect(result.options).toHaveLength(4);
        result.options.forEach((option, optionIndex) => {
          expect(checkAnswer([current], direction, option.text).isCorrect).toBe(optionIndex === result.correctOptionIndex);
        });
      }
    });
  });

  it.each([
    { size: 1, buttons: 0 },
    { size: 2, buttons: 2 },
    { size: 3, buttons: 3 },
    { size: 4, buttons: 4 },
    { size: 5, buttons: 4 },
  ])("словарь из $size слов: кнопок $buttons", ({ size, buttons }) => {
    const dictionary = [fast, ...pool].slice(0, size);
    for (let seed = 0; seed < 10; seed++) {
      const result = buildChoiceOptions({ card: fast, direction: "ru_en", pool: dictionary, rng: createSeededRng(seed) });
      if (buttons === 0) expect(result).toEqual({ available: false, reason: "no_distractors" });
      else expect(texts(result)).toHaveLength(buttons);
    }
  });

  it("количество вариантов задаётся параметром", () => {
    const result = buildChoiceOptions({ card: fast, direction: "ru_en", pool, rng: createSeededRng(1), optionCount: 3 });
    expect(texts(result)).toHaveLength(3);
  });
});
