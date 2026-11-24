// Разбор вставленной таблицы или CSV в строки предварительного просмотра.
import { makeWordKey, type WordKey } from "../../domain/word-key.js";
import { prepareCard, validateCard, type ImportedCard } from "./card.js";
import { IMPORT_COLUMNS, looksLikeHeader } from "./columns.js";
import { detectDelimiter, isBlankRecord, parseRecords, stripBom, type Delimiter, type RawRecord } from "./csv.js";

export type ImportDuplicate = null | { kind: "in_import"; line: number } | { kind: "existing" };

export type ImportRow = {
  /** Номер строки во вставленном тексте, с 1 (с учётом заголовка и пустых строк). */
  line: number;
  /** null, если строку нельзя принять. */
  card: ImportedCard | null;
  /** Понятные преподавателю, по-русски, с номером строки. */
  errors: string[];
  /** Дубль — не ошибка: card заполнен, а сервер такую строку не добавляет. */
  duplicate: ImportDuplicate;
};

export type ImportResult = {
  rows: ImportRow[];
  delimiter: Delimiter;
  hasHeader: boolean;
  /** Строк данных больше maxRows; в rows только первые maxRows. */
  tooManyRows: boolean;
};

export type ParseCardTableOptions = {
  /** Карточки, уже лежащие в подборке: совпадения помечаются duplicate.kind = "existing". */
  existing?: readonly { english: string; translation: string }[];
  /** По умолчанию 500. */
  maxRows?: number;
};

export const DEFAULT_MAX_ROWS = 500;

const YES = new Set(["да", "д", "yes", "y", "1", "+", "true", "истина"]);
const NO = new Set(["нет", "н", "no", "n", "0", "-", "–", "—", "false", "ложь"]);

const ALLOW_OMIT_TO_TITLE = IMPORT_COLUMNS[6]!.title.toLowerCase();

function parseYesNo(value: string): boolean | string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "" || NO.has(normalized)) return false;
  if (YES.has(normalized)) return true;
  return `столбец «${ALLOW_OMIT_TO_TITLE}»: ожидается да или нет, получено «${value.trim()}»`;
}

function keyString(key: WordKey): string {
  return `${key.normalizedEnglish}\u0000${key.normalizedTranslation}`;
}

/** Ключ по makeWordKey; совпадение строк ключа — то же самое, что sameWord. */
function tryKey(english: string, translation: string): string | null {
  try {
    return keyString(makeWordKey(english, translation));
  } catch {
    return null;
  }
}

function buildRow(record: RawRecord): { card: ImportedCard | null; errors: string[] } {
  const cells = record.fields.map((field) => field.trim());
  const cell = (index: number) => cells[index] ?? "";
  const errors: string[] = [];

  if (record.unclosedQuote) {
    errors.push("не закрыта кавычка: всё после неё до конца текста попало в одну ячейку");
  }
  const extra = cells.slice(IMPORT_COLUMNS.length).filter((value) => value !== "");
  if (extra.length > 0) {
    errors.push(
      `лишние столбцы после «${ALLOW_OMIT_TO_TITLE}»: ${extra.map((value) => `«${value}»`).join(", ")}. ` +
        "Возможно, в ячейке есть разделитель — возьмите её в кавычки",
    );
  }
  const allowOmitTo = parseYesNo(cell(6));
  if (typeof allowOmitTo === "string") errors.push(allowOmitTo);

  const card = prepareCard({
    english: cell(0),
    translation: cell(1),
    example: cell(2),
    explanation: cell(3),
    acceptedRuEn: cell(4),
    acceptedEnRu: cell(5),
    allowOmitTo: allowOmitTo === true,
  });
  errors.push(...validateCard(card));
  return errors.length > 0 ? { card: null, errors } : { card, errors };
}

/**
 * Разбирает вставку из Google Таблиц или Excel либо текст CSV. Ничего не сохраняет:
 * результат нужен для предварительного просмотра в кабинете и повторной проверки на сервере.
 */
export function parseCardTable(text: string, options: ParseCardTableOptions = {}): ImportResult {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const source = stripBom(text);
  const delimiter = detectDelimiter(source);
  let records = parseRecords(source, delimiter).filter((record) => !isBlankRecord(record));

  const hasHeader = records.length > 0 && looksLikeHeader(records[0]!.fields.map((f) => f.trim()));
  if (hasHeader) records = records.slice(1);

  const tooManyRows = records.length > maxRows;
  if (tooManyRows) records = records.slice(0, maxRows);

  const existing = new Set<string>();
  for (const card of options.existing ?? []) {
    const key = tryKey(card.english, card.translation);
    if (key) existing.add(key);
  }
  const firstLine = new Map<string, number>();

  const rows = records.map((record): ImportRow => {
    const { card, errors } = buildRow(record);
    let duplicate: ImportDuplicate = null;
    // Дубли ищутся только среди принимаемых строк: строка с ошибкой не будет добавлена.
    const key = card ? tryKey(card.english, card.translation) : null;
    if (key) {
      const first = firstLine.get(key);
      if (first !== undefined) duplicate = { kind: "in_import", line: first };
      else if (existing.has(key)) duplicate = { kind: "existing" };
      else firstLine.set(key, record.line);
    }
    return { line: record.line, card, errors: errors.map((error) => `Строка ${record.line}: ${error}`), duplicate };
  });

  return { rows, delimiter, hasHeader, tooManyRows };
}
