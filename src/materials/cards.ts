// Карточка из редактора: подготовка и проверка общими правилами src/shared/card-import.
import { makeWordKey, sameWord, type WordKey } from "../domain/index.js";
import { prepareCard, validateCard, type ImportedCard } from "../shared/card-import/index.js";
import type { CardInput } from "../shared/api-contract.js";
import { MaterialsError } from "./errors.js";

export type { ImportedCard };

/** Готовит и проверяет карточку. Ошибки — 422 invalid_card с текстами для преподавателя. */
export function acceptCard(input: CardInput): ImportedCard {
  const card = prepareCard({
    english: input.english,
    translation: input.translation,
    example: input.example ?? null,
    explanation: input.explanation ?? null,
    acceptedRuEn: input.acceptedRuEn ?? [],
    acceptedEnRu: input.acceptedEnRu ?? [],
    allowOmitTo: input.allowOmitTo ?? false,
  });
  const errors = validateCard(card);
  if (errors.length > 0) throw new MaterialsError("invalid_card", errors);
  return card;
}

export const keyOf = (pair: { english: string; translation: string }): WordKey => makeWordKey(pair.english, pair.translation);

export function hasSameWord(rows: readonly { english: string; translation: string }[], card: { english: string; translation: string }) {
  const key = keyOf(card);
  return rows.some((row) => sameWord(keyOf(row), key));
}

/** Поля таблиц source_cards и card_versions. */
export const storedFields = (card: ImportedCard) => ({
  english: card.english,
  primaryTranslation: card.translation,
  acceptedRuEn: card.acceptedRuEn,
  acceptedEnRu: card.acceptedEnRu,
  example: card.example,
  explanation: card.explanation,
  allowOmitTo: card.allowOmitTo,
});

type StoredCard = ReturnType<typeof storedFields>;

/** Содержимое для ответа API. */
export const contentOf = (row: StoredCard) => ({
  english: row.english,
  translation: row.primaryTranslation,
  example: row.example,
  explanation: row.explanation,
  acceptedRuEn: row.acceptedRuEn,
  acceptedEnRu: row.acceptedEnRu,
  allowOmitTo: row.allowOmitTo,
});

export function sameContent(a: StoredCard, b: StoredCard) {
  return JSON.stringify(contentOf(a)) === JSON.stringify(contentOf(b));
}
