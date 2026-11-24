import { describe, expect, it } from "vitest";
import { EmptyWordTextError, makeWordKey, normalizeAnswerText, normalizeWordText, sameWord } from "../src/domain/index.js";

describe("normalizeWordText", () => {
  it.each([
    ["  Fast ", "fast"],
    ["Christmas   tree", "christmas tree"],
    ["ЁЛКА", "елка"],
    ["зелёный", "зеленый"],
    ["зелёный", "зеленый"], // ё из двух кодовых точек
    ["за́втрак", "завтрак"], // знак ударения
    ["fast food", "fast food"], // неразрывный пробел
    ["fa​st", "fast"], // невидимый символ
    ["йогурт", "йогурт"], // й не теряется при удалении знаков
  ])("%j → %j", (input, expected) => {
    expect(normalizeWordText(input)).toBe(expected);
  });

  it("не трогает пунктуацию и to", () => {
    expect(normalizeWordText("How much is it?")).toBe("how much is it?");
    expect(normalizeWordText("to go")).toBe("to go");
  });
});

describe("normalizeAnswerText", () => {
  it.each([
    ["How much is it?", "how much is it"],
    ["don't", "dont"],
    ["don’t", "dont"],
    ["don´t", "dont"],
    ["well-known", "well known"],
    ["hello,world", "hello world"],
    ["  «Завтрак»!  ", "завтрак"],
    ["...", ""],
    ["", ""],
  ])("%j → %j", (input, expected) => {
    expect(normalizeAnswerText(input)).toBe(expected);
  });

  it("убирает to только при разрешении и только в начале", () => {
    expect(normalizeAnswerText("to go")).toBe("to go");
    expect(normalizeAnswerText("to go", { allowOmitTo: true })).toBe("go");
    expect(normalizeAnswerText("To  Go!", { allowOmitTo: true })).toBe("go");
    expect(normalizeAnswerText("go to bed", { allowOmitTo: true })).toBe("go to bed");
    expect(normalizeAnswerText("used to", { allowOmitTo: true })).toBe("used to");
    expect(normalizeAnswerText("to", { allowOmitTo: true })).toBe("to");
    expect(normalizeAnswerText("tomorrow", { allowOmitTo: true })).toBe("tomorrow");
  });
});

describe("makeWordKey", () => {
  it("сравнивает обе части пары", () => {
    expect(sameWord(makeWordKey("Fast", "Быстрый"), makeWordKey(" fast ", "быстрый"))).toBe(true);
    expect(sameWord(makeWordKey("bank", "банк"), makeWordKey("bank", "берег"))).toBe(false);
  });

  it("отклоняет пустой текст", () => {
    expect(() => makeWordKey("  ", "банк")).toThrow(EmptyWordTextError);
    expect(() => makeWordKey("bank", "​")).toThrow(EmptyWordTextError);
  });
});
