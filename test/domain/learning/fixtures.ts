import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnswerCard } from "../../../src/domain/learning/index.js";

type FixtureCard = {
  english: string;
  translation: string;
  acceptedRuEn: string[];
  acceptedEnRu: string[];
  allowOmitTo: boolean;
};

const dir = "fixtures/collections";

/** Карточки тестовых подборок. Файлы читаются напрямую: загрузчик из src/db зависит от Drizzle. */
export const fixtureCards: AnswerCard[] = readdirSync(dir).flatMap((file) => {
  const collection = JSON.parse(readFileSync(join(dir, file), "utf8")) as { cards: FixtureCard[] };
  return collection.cards.map((card) => ({
    english: card.english,
    primaryTranslation: card.translation,
    acceptedRuEn: card.acceptedRuEn,
    acceptedEnRu: card.acceptedEnRu,
    allowOmitTo: card.allowOmitTo,
  }));
});

export function card(english: string, primaryTranslation: string, extra: Partial<AnswerCard> = {}): AnswerCard {
  return { english, primaryTranslation, acceptedRuEn: [], acceptedEnRu: [], allowOmitTo: false, ...extra };
}
