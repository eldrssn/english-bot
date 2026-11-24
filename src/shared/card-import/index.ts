// Импорт карточек (Этап 4): разбор вставки из Google Таблиц, Excel и CSV, проверка карточек, дубли.
// Работает в браузере (предпросмотр в кабинете) и на сервере (повторная проверка перед сохранением):
// зависит только от zod и чистых функций src/domain, без Node API, DOM, базы и grammY.
import { z } from "zod";
import { validateCard, type ImportedCard } from "./card.js";

export { CARD_LIMITS, cleanAcceptedAnswers, prepareCard, startsWithTo, validateCard } from "./card.js";
export type { CardInput, ImportedCard } from "./card.js";
export { IMPORT_COLUMNS } from "./columns.js";
export type { ImportColumn, ImportColumnKey } from "./columns.js";
export { DEFAULT_MAX_ROWS, parseCardTable } from "./parse-table.js";
export type { ImportDuplicate, ImportResult, ImportRow, ParseCardTableOptions } from "./parse-table.js";
export type { Delimiter } from "./csv.js";

/**
 * Схема карточки для тела запроса: форма, затем правила validateCard.
 * Сообщения validateCard попадают в issues как есть. Перед проверкой серверу стоит пропустить
 * ввод через prepareCard, чтобы обрезка и очистка вариантов совпадали с предпросмотром.
 */
export const importedCardSchema = z
  .object({
    english: z.string(),
    translation: z.string(),
    example: z.string().nullable(),
    explanation: z.string().nullable(),
    acceptedRuEn: z.array(z.string()),
    acceptedEnRu: z.array(z.string()),
    allowOmitTo: z.boolean(),
  })
  .strict()
  .superRefine((card: ImportedCard, ctx) => {
    for (const message of validateCard(card)) ctx.addIssue({ code: "custom", message });
  });
