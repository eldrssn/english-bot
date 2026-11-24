import { describe, expect, it } from "vitest";
import { computeCollectionStatus, type CollectionCardProgress } from "../../../src/domain/learning/index.js";

const fresh: CollectionCardProgress = { isDeleted: false, wasViewed: false, hasAnswer: false };
const viewed = { ...fresh, wasViewed: true };
const answered = { ...fresh, wasViewed: true, hasAnswer: true };
const answeredBlind = { ...fresh, hasAnswer: true };

describe("computeCollectionStatus", () => {
  it.each([
    { name: "ничего не открыто", cards: [fresh, fresh], status: "assigned" },
    { name: "открыта одна карточка, ответов нет", cards: [viewed, fresh], status: "started" },
    { name: "часть ответов", cards: [answered, viewed], status: "practicing" },
    { name: "ответ без просмотра тоже считается", cards: [answeredBlind, fresh], status: "practicing" },
    { name: "ответы по всем", cards: [answered, answered], status: "completed" },
    { name: "ответы по всем, карточки не открывались", cards: [answeredBlind], status: "completed" },
    { name: "завершённая с новой карточкой снова практикует", cards: [answered, answered, fresh], status: "practicing" },
    { name: "новая карточка удалена — снова завершена", cards: [answered, answered, { ...fresh, isDeleted: true }], status: "completed" },
    { name: "удалена единственная неотвеченная", cards: [answered, { ...viewed, isDeleted: true }], status: "completed" },
    { name: "ответ по удалённой не считается", cards: [fresh, { ...answered, isDeleted: true }], status: "assigned" },
    { name: "просмотр удалённой не считается", cards: [fresh, { ...viewed, isDeleted: true }], status: "assigned" },
    { name: "просмотр действующей при ответе по удалённой", cards: [viewed, { ...answered, isDeleted: true }], status: "started" },
    { name: "пустая подборка не считается завершённой", cards: [], status: "assigned" },
    { name: "все карточки удалены — не завершена", cards: [{ ...answered, isDeleted: true }], status: "assigned" },
  ] as const)("$name → $status", ({ cards, status }) => {
    expect(computeCollectionStatus(cards)).toBe(status);
  });
});
