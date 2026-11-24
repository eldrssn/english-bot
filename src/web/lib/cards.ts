// Форма карточки: значения полей, проверка общим модулем импорта, ошибки по полям, дубли, чтение CSV.
import { prepareCard, validateCard, type ImportedCard } from "../../shared/card-import/index.js";
import type { CardContent, CardInput } from "../../shared/api-contract";
import { makeWordKey } from "../../domain/word-key.js";
import { sentence } from "./api";

export type CardFields = {
  english: string;
  translation: string;
  example: string;
  explanation: string;
  acceptedRuEn: string;
  acceptedEnRu: string;
  allowOmitTo: boolean;
};

export type CardFieldName = keyof CardFields;

export const EMPTY_CARD: CardFields = {
  english: "",
  translation: "",
  example: "",
  explanation: "",
  acceptedRuEn: "",
  acceptedEnRu: "",
  allowOmitTo: false,
};

export function fieldsFromCard(card: CardContent): CardFields {
  return {
    english: card.english,
    translation: card.translation,
    example: card.example ?? "",
    explanation: card.explanation ?? "",
    acceptedRuEn: card.acceptedRuEn.join("; "),
    acceptedEnRu: card.acceptedEnRu.join("; "),
    allowOmitTo: card.allowOmitTo,
  };
}

/** Тело запроса: сервер сам обрежет пробелы и разберёт варианты через «;». */
export function inputFromFields(fields: CardFields): CardInput {
  return {
    english: fields.english,
    translation: fields.translation,
    example: fields.example.trim() === "" ? null : fields.example,
    explanation: fields.explanation.trim() === "" ? null : fields.explanation,
    acceptedRuEn: fields.acceptedRuEn,
    acceptedEnRu: fields.acceptedEnRu,
    allowOmitTo: fields.allowOmitTo,
  };
}

export function prepareFields(fields: CardFields): ImportedCard {
  return prepareCard(inputFromFields(fields));
}

export type FieldErrors = Partial<Record<CardFieldName, string[]>> & { other?: string[] };

/**
 * К какому полю относится сообщение validateCard. Сообщения общие для формы, импорта и сервера,
 * номера поля в них нет, поэтому поле определяется по началу текста; незнакомое — в общий список.
 */
export function fieldOfMessage(message: string): CardFieldName | "other" {
  const text = message.replace(/^Карточка \d+: /, "");
  if (text.startsWith("нет слова") || text.startsWith("слово или фраза")) return "english";
  if (text.startsWith("нет перевода") || text.startsWith("перевод ")) return "translation";
  if (text.startsWith("пример")) return "example";
  if (text.startsWith("пояснение")) return "explanation";
  if (text.startsWith("отмечено «можно без to»")) return "allowOmitTo";
  if (text.includes("ru→en")) return "acceptedRuEn";
  if (text.includes("en→ru")) return "acceptedEnRu";
  return "other";
}

export function groupErrors(messages: readonly string[]): FieldErrors {
  const result: FieldErrors = {};
  for (const message of messages) {
    const field = fieldOfMessage(message);
    (result[field] ??= []).push(sentence(message));
  }
  return result;
}

export function validateFields(fields: CardFields): FieldErrors {
  return groupErrors(validateCard(prepareFields(fields)));
}

export const hasErrors = (errors: FieldErrors) => Object.values(errors).some((list) => list && list.length > 0);

/** Тот же ключ, что у бота и сервера: регистр, пробелы, ё = е. */
export function wordKey(english: string, translation: string): string | null {
  try {
    const key = makeWordKey(english, translation);
    return `${key.normalizedEnglish}\u0000${key.normalizedTranslation}`;
  } catch {
    return null;
  }
}

/** Карточка из подборки с тем же словом и переводом. */
export function findDuplicate<T extends { id: number; english: string; translation: string }>(
  fields: CardFields,
  cards: readonly T[],
  exceptId?: number,
): T | undefined {
  const key = wordKey(fields.english, fields.translation);
  if (key === null) return undefined;
  return cards.find((card) => card.id !== exceptId && wordKey(card.english, card.translation) === key);
}

// ---------- Файл CSV ----------

export type DecodedFile = { text: string; encoding: "utf-8" | "utf-16" | "windows-1251" };

/**
 * Читает CSV. Русский Excel часто сохраняет «CSV» в Windows-1251: такой текст не проходит строгую
 * проверку UTF-8 (русские буквы в cp1251 почти никогда не складываются в верный UTF-8), тогда читаем как cp1251.
 */
export async function readCsvFile(file: File): Promise<DecodedFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    return { text: new TextDecoder(bytes[0] === 0xff ? "utf-16le" : "utf-16be").decode(bytes), encoding: "utf-16" };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1251").decode(bytes), encoding: "windows-1251" };
  }
}

/** Файл не похож на таблицу: Excel-книга или картинка вместо CSV. */
export function looksBinary(text: string): boolean {
  return text.slice(0, 2000).includes("\u0000");
}
