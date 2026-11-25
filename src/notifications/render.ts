import { InlineKeyboard } from "grammy";
import { DAILY_START, collectionFromNotification, timezoneList } from "../bot/callback-data.js";
import type { NotificationReason } from "./queue.js";

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** Текст уведомления. null: для причины нет сообщения (запись помечается неотправленной). */
export function renderNotification(reason: NotificationReason, payload: Record<string, unknown>): string | null {
  switch (reason) {
    case "join_request": {
      const account = [text(payload.telegramName), text(payload.telegramUsername) && `@${String(payload.telegramUsername)}`]
        .filter(Boolean)
        .join(", ");
      return (
        `Новая заявка: ${text(payload.displayName) ?? "ученик"}` +
        (account ? ` (Telegram: ${account})` : "") +
        ". Сверьте аккаунт и введите проверочный код в кабинете."
      );
    }
    case "request_withdrawn":
      return (
        `Заявка отменена: ${text(payload.displayName) ?? "ученик"}. ` +
        "Ученик перешёл по другой ссылке. При необходимости создайте новую в кабинете."
      );
    case "link_confirmed":
      return (
        "Преподаватель подтвердил подключение. Материалы открыты. " +
        "Выберите часовой пояс: по нему приходят напоминания о ежедневной практике. " +
        "Меню откроется по команде /start."
      );
    case "link_ended":
      return (
        "Преподаватель больше не ведёт ваши занятия. Ваш прогресс и полученные материалы сохраняются, " +
        "но новых материалов не будет. Чтобы подключиться снова, нужна новая ссылка."
      );
    case "request_rejected":
      return "Преподаватель отклонил заявку. Если это ошибка, попросите у него новую ссылку.";
    case "new_collection":
      return (
        `Новая подборка: ${text(payload.title) ?? "без названия"}. Слов: ${Number(payload.wordCount) || 0}. ` +
        "Посмотрите карточки и начните практику."
      );
    case "collection_extended":
      return (
        `В подборку добавлены слова: ${text(payload.title) ?? "без названия"}. Новых карточек: ${Number(payload.addedCount) || 0}. ` +
        "Посмотрите их и продолжите практику."
      );
    case "daily_reminder":
      // Дословно по разделу 9 сценария.
      return "Сегодня короткая практика: повторить сложные слова и проверить новые.";
  }
}

/** Кнопки уведомления. undefined: уведомление только с текстом. */
export function notificationKeyboard(reason: NotificationReason, payload: Record<string, unknown>): InlineKeyboard | undefined {
  // «Начать» ведёт к сегодняшнему квесту: если он уже открыт — к продолжению, второго не создаёт.
  if (reason === "daily_reminder") return new InlineKeyboard().text("Начать", DAILY_START);
  if (reason === "link_confirmed") return new InlineKeyboard().text("Выбрать часовой пояс", timezoneList(0));
  if (reason !== "new_collection" && reason !== "collection_extended") return undefined;
  const collectionId = Number(payload.studentCollectionId);
  if (!Number.isSafeInteger(collectionId) || collectionId <= 0) return undefined;
  return new InlineKeyboard().text("Посмотреть", collectionFromNotification(collectionId));
}
