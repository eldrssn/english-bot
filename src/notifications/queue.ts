import type { DbOrTx } from "../db/client.js";
import { notifications } from "../db/schema.js";

export type NotificationReason = (typeof notifications.$inferInsert)["reason"];

/** Ставит уведомление в очередь. Повторная постановка с тем же ключом не создаёт второе сообщение. */
export async function enqueueNotification(
  db: DbOrTx,
  input: {
    recipientUserId: number;
    reason: NotificationReason;
    dedupeKey: string;
    payload?: Record<string, unknown>;
  },
) {
  await db
    .insert(notifications)
    .values({
      recipientUserId: input.recipientUserId,
      reason: input.reason,
      dedupeKey: input.dedupeKey,
      payload: input.payload ?? {},
    })
    .onConflictDoNothing({ target: notifications.dedupeKey });
}

/** Уведомление о новой копии. Ключ один на копию: подтверждение связи и выдача не дадут двух сообщений. */
export async function enqueueNewCollection(
  db: DbOrTx,
  recipientUserId: number,
  collection: { id: number; title: string; wordCount: number },
) {
  await enqueueNotification(db, {
    recipientUserId,
    reason: "new_collection",
    dedupeKey: `new_collection:${collection.id}`,
    payload: { studentCollectionId: collection.id, title: collection.title, wordCount: collection.wordCount },
  });
}

/**
 * Уведомление о дополнении копии: одно на действие преподавателя. Ключ — копия и первая добавленная карточка:
 * повторная постановка того же действия не даст второго сообщения, следующее дополнение получит своё.
 */
export async function enqueueCollectionExtended(
  db: DbOrTx,
  recipientUserId: number,
  extension: { collectionId: number; title: string; addedCount: number; firstCardId: number },
) {
  await enqueueNotification(db, {
    recipientUserId,
    reason: "collection_extended",
    dedupeKey: `collection_extended:${extension.collectionId}:${extension.firstCardId}`,
    payload: { studentCollectionId: extension.collectionId, title: extension.title, addedCount: extension.addedCount },
  });
}
