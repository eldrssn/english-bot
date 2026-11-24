// Разбор таблицы по RFC 4180 с поблажками для вставки из Google Таблиц и Excel.

export type Delimiter = "tab" | "comma" | "semicolon";

export const DELIMITER_CHARS: Record<Delimiter, string> = { tab: "\t", comma: ",", semicolon: ";" };

export type RawRecord = {
  /** Номер физической строки текста, с которой начинается запись, с 1. */
  line: number;
  /** Значения ячеек как есть, без обрезки пробелов. */
  fields: string[];
  /** Текст закончился внутри кавычек: всё после открывающей кавычки попало в одну ячейку. */
  unclosedQuote: boolean;
};

/** Убирает BOM в начале текста. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Разбирает текст на записи. Переносы строк: CRLF, LF и CR. Кавычки по RFC 4180: поле в кавычках
 * может содержать разделитель и перенос строки, `""` внутри — одна кавычка. Пробелы перед
 * открывающей кавычкой допускаются; кавычка в середине поля без кавычек считается обычным символом.
 */
export function parseRecords(text: string, delimiter: Delimiter): RawRecord[] {
  const delim = DELIMITER_CHARS[delimiter];
  const records: RawRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let wasQuoted = false;
  let line = 1;
  let recordLine = 1;
  let i = 0;

  const newlineLength = (at: number) => (text[at] === "\r" && text[at + 1] === "\n" ? 2 : 1);

  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else if (ch === "\r" || ch === "\n") {
        field += "\n";
        i += newlineLength(i);
        line += 1;
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }
    if (ch === '"' && !wasQuoted && field.trim() === "") {
      inQuotes = true;
      wasQuoted = true;
      field = "";
      i += 1;
    } else if (ch === delim) {
      fields.push(field);
      field = "";
      wasQuoted = false;
      i += 1;
    } else if (ch === "\r" || ch === "\n") {
      fields.push(field);
      records.push({ line: recordLine, fields, unclosedQuote: false });
      fields = [];
      field = "";
      wasQuoted = false;
      i += newlineLength(i);
      line += 1;
      recordLine = line;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (inQuotes || wasQuoted || field !== "" || fields.length > 0) {
    fields.push(field);
    records.push({ line: recordLine, fields, unclosedQuote: inQuotes });
  }
  return records;
}

export function isBlankRecord(record: RawRecord): boolean {
  return !record.unclosedQuote && record.fields.every((field) => field.trim() === "");
}

const SAMPLE_SIZE = 50;
const EXPECTED_COLUMNS = 7;

/** Сколько очков даёт запись: 2–7 столбцов — хорошо, один — ноль, лишние столбцы — штраф. */
function recordScore(columns: number): number {
  if (columns < 2) return 0;
  if (columns <= EXPECTED_COLUMNS) return columns;
  return Math.max(0, 2 * EXPECTED_COLUMNS - columns);
}

/**
 * Определяет разделитель по первым непустым записям.
 * Табуляция (вставка из Google Таблиц и Excel) выбирается, если делит хотя бы половину записей:
 * в ячейках таблицы часто есть запятые, а табуляций в CSV почти не бывает.
 * Между `;` и `,` выигрывает тот, при котором записи ближе к ожидаемым 2–7 столбцам;
 * при равенстве — `;` (русский Excel), без разделителей вовсе — табуляция.
 */
export function detectDelimiter(text: string): Delimiter {
  const sample = (delimiter: Delimiter) =>
    parseRecords(text, delimiter)
      .filter((record) => !isBlankRecord(record))
      .slice(0, SAMPLE_SIZE);

  const byTab = sample("tab");
  if (byTab.length > 0 && byTab.filter((r) => r.fields.length >= 2).length * 2 >= byTab.length) {
    return "tab";
  }
  const score = (delimiter: Delimiter) =>
    sample(delimiter).reduce((sum, record) => sum + recordScore(record.fields.length), 0);
  const semicolon = score("semicolon");
  const comma = score("comma");
  if (semicolon === 0 && comma === 0) return "tab";
  return comma > semicolon ? "comma" : "semicolon";
}
