import { normalizeWordText } from "./normalize.js";

/** Слова считаются одним, только если совпали и английский текст, и основной перевод. */
export type WordKey = {
  normalizedEnglish: string;
  normalizedTranslation: string;
};

export class EmptyWordTextError extends Error {
  override name = "EmptyWordTextError";
}

export function makeWordKey(english: string, translation: string): WordKey {
  const normalizedEnglish = normalizeWordText(english);
  const normalizedTranslation = normalizeWordText(translation);
  if (!normalizedEnglish || !normalizedTranslation) {
    throw new EmptyWordTextError("Английский текст и перевод карточки не могут быть пустыми");
  }
  return { normalizedEnglish, normalizedTranslation };
}

export function sameWord(a: WordKey, b: WordKey): boolean {
  return a.normalizedEnglish === b.normalizedEnglish && a.normalizedTranslation === b.normalizedTranslation;
}
