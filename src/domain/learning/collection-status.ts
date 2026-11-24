export type CollectionStatus = "assigned" | "started" | "practicing" | "completed";

/** Что известно об одной карточке личной копии подборки. */
export type CollectionCardProgress = {
  isDeleted: boolean;
  wasViewed: boolean;
  hasAnswer: boolean;
};

/**
 * Статус подборки (раздел 2.5 плана, раздел 11 сценария). Считается только по действующим карточкам.
 * Новая карточка без ответа сама возвращает завершённую подборку в practicing.
 * «Не подключён» — состояние связи, а не подборки, поэтому его здесь нет.
 */
export function computeCollectionStatus(cards: readonly CollectionCardProgress[]): CollectionStatus {
  const active = cards.filter((card) => !card.isDeleted);
  if (active.length === 0) return "assigned";
  if (active.every((card) => card.hasAnswer)) return "completed";
  if (active.some((card) => card.hasAnswer)) return "practicing";
  return active.some((card) => card.wasViewed) ? "started" : "assigned";
}
