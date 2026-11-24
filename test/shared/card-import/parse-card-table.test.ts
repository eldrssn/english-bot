import { describe, expect, it } from "vitest";
import {
  CARD_LIMITS,
  IMPORT_COLUMNS,
  importedCardSchema,
  parseCardTable,
  prepareCard,
  validateCard,
  type ImportedCard,
} from "../../../src/shared/card-import/index.js";
import { parseRecords, stripBom } from "../../../src/shared/card-import/csv.js";

const card = (overrides: Partial<ImportedCard> = {}): ImportedCard => ({
  english: "fast",
  translation: "быстрый",
  example: null,
  explanation: null,
  acceptedRuEn: [],
  acceptedEnRu: [],
  allowOmitTo: false,
  ...overrides,
});

describe("форматы вставки", () => {
  it("Google Таблицы: табуляция, запятые внутри ячеек не делят столбцы", () => {
    const text = [
      "to run\tбежать\tI run fast, every day.\t\trun\tбегать; носиться\tда",
      "fast\tбыстрый, скорый",
    ].join("\n");
    const result = parseCardTable(text);
    expect(result.delimiter).toBe("tab");
    expect(result.hasHeader).toBe(false);
    expect(result.rows).toEqual([
      {
        line: 1,
        card: {
          english: "to run",
          translation: "бежать",
          example: "I run fast, every day.",
          explanation: null,
          acceptedRuEn: [], // «run» совпадает с «to run» при разрешённом пропуске to
          acceptedEnRu: ["бегать", "носиться"],
          allowOmitTo: true,
        },
        errors: [],
        duplicate: null,
      },
      {
        line: 2,
        card: card({ translation: "быстрый, скорый" }),
        errors: [],
        duplicate: null,
      },
    ]);
  });

  it("Google Таблицы: ячейка с переносом приходит в кавычках", () => {
    const text = 'look up\tискать\t"Look it up\nin the dictionary."\n' + "fast\tбыстрый";
    const result = parseCardTable(text);
    expect(result.delimiter).toBe("tab");
    expect(result.rows.map((row) => row.line)).toEqual([1, 3]);
    expect(result.rows[0]!.card!.example).toBe("Look it up\nin the dictionary.");
  });

  it("CSV с запятыми: кавычки, удвоенные кавычки, разделитель внутри кавычек", () => {
    const text = [
      'english,translation,example',
      '"run, fast",бежать быстро,"He said ""run!"""',
      'bank,банк,',
    ].join("\r\n");
    const result = parseCardTable(text);
    expect(result.delimiter).toBe("comma");
    expect(result.hasHeader).toBe(true);
    expect(result.rows.map((row) => [row.line, row.card?.english, row.card?.translation, row.card?.example])).toEqual([
      [2, "run, fast", "бежать быстро", 'He said "run!"'],
      [3, "bank", "банк", null],
    ]);
  });

  it("русский Excel: точка с запятой, запятые в ячейках, пустые хвостовые столбцы, BOM и CRLF", () => {
    const text = "﻿Слово;Перевод;Пример;Пояснение;Ответы ru→en;Ответы en→ru;Можно без to\r\n" +
      "fast;быстрый, скорый;Run fast, now!;;quick;скоро;нет\r\n" +
      "bank;берег;;;;;\r\n";
    const result = parseCardTable(text);
    expect(result.delimiter).toBe("semicolon");
    expect(result.hasHeader).toBe(true);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      line: 2,
      errors: [],
      card: card({
        translation: "быстрый, скорый",
        example: "Run fast, now!",
        acceptedRuEn: ["quick"],
        acceptedEnRu: ["скоро"],
      }),
    });
    expect(result.rows[1]).toMatchObject({ line: 3, card: card({ english: "bank", translation: "берег" }) });
  });

  it("CSV с запятыми: «;» без кавычек внутри столбца ответов не сбивает разделитель", () => {
    const result = parseCardTable("fast,быстрый,,,quick;rapid,скорый;шустрый,нет");
    expect(result.delimiter).toBe("comma");
    expect(result.rows[0]!.card).toEqual(
      card({ acceptedRuEn: ["quick", "rapid"], acceptedEnRu: ["скорый", "шустрый"] }),
    );
  });

  it("перенос внутри кавычек в CSV: номер следующей строки остаётся настоящим", () => {
    const text = 'fast;быстрый;"Line one\r\nline two\r\nline three"\nbank;банк';
    const result = parseCardTable(text);
    expect(result.rows.map((row) => row.line)).toEqual([1, 4]);
    expect(result.rows[0]!.card!.example).toBe("Line one\nline two\nline three");
  });

  it("равный счёт «;» и «,» решается в пользу «;» (русский Excel)", () => {
    const result = parseCardTable("fast;быстрый, скорый");
    expect(result.delimiter).toBe("semicolon");
    expect(result.rows[0]!.card).toEqual(card({ translation: "быстрый, скорый" }));
  });

  it("parseRecords: BOM убирается до разбора, значения ячеек приходят без обрезки", () => {
    expect(parseRecords(stripBom('\uFEFF a ;"b;c"\r\n'), "semicolon")).toEqual([
      { line: 1, fields: [" a ", "b;c"], unclosedQuote: false },
    ]);
    expect(stripBom("\uFEFFfast")).toBe("fast");
  });

  it("BOM в начале не попадает в первое слово", () => {
    const result = parseCardTable("﻿fast\tбыстрый");
    expect(result.rows[0]!.card!.english).toBe("fast");
  });

  it("пустые строки пропускаются, номера строк настоящие; пробелы по краям обрезаются", () => {
    const text = "\n  fast  \t  быстрый  \n\n\t\t\n   \nbank\tбанк\n\n";
    const result = parseCardTable(text);
    expect(result.rows.map((row) => [row.line, row.card?.english, row.card?.translation])).toEqual([
      [2, "fast", "быстрый"],
      [6, "bank", "банк"],
    ]);
  });

  it("пустой текст", () => {
    expect(parseCardTable("")).toEqual({ rows: [], delimiter: "tab", hasHeader: false, tooManyRows: false });
    expect(parseCardTable("﻿\r\n\r\n").rows).toEqual([]);
  });

  it("незакрытая кавычка — ошибка строки, а не потерянные данные", () => {
    const result = parseCardTable('fast;быстрый\nbank;"банк\nriver;река');
    expect(result.rows).toHaveLength(2);
    expect(result.rows[1]!.card).toBeNull();
    expect(result.rows[1]!.errors[0]).toMatch(/^Строка 2: не закрыта кавычка/);
  });
});

describe("заголовок", () => {
  it.each([
    "Слово или фраза по-английски\tОсновной перевод\tПример",
    "English\tRussian",
    "word\ttranslation\texample\texplanation",
    "Английский;Перевод",
    IMPORT_COLUMNS.map((column) => column.title).join("\t"),
  ])("распознаётся: %j", (header) => {
    const result = parseCardTable(`${header}\nfast\tбыстрый`.replaceAll(";", "\t"));
    expect(result.hasHeader).toBe(true);
    expect(result.rows.map((row) => row.line)).toEqual([2]);
  });

  it.each(["word\tслово", "fast\tбыстрый", "English\tанглийский язык", "translation\tперевод слова"])(
    "строка данных не считается заголовком: %j",
    (first) => {
      const result = parseCardTable(`${first}\nbank\tбанк`);
      expect(result.hasHeader).toBe(false);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]!.line).toBe(1);
    },
  );

  it("заголовок после пустых строк", () => {
    const result = parseCardTable("\n\nword,translation\nfast,быстрый");
    expect(result.hasHeader).toBe(true);
    expect(result.rows.map((row) => row.line)).toEqual([4]);
  });
});

describe("столбцы", () => {
  it("недостающие необязательные столбцы считаются пустыми", () => {
    const result = parseCardTable("fast\tбыстрый\tRun fast.");
    expect(result.rows[0]!.card).toEqual(card({ example: "Run fast." }));
  });

  it("нет перевода: «Строка N: нет перевода»", () => {
    const result = parseCardTable("fast\tбыстрый\n\n\nbank\t\nriver");
    expect(result.rows.map((row) => [row.line, row.card, row.errors])).toEqual([
      [1, card(), []],
      [4, null, ["Строка 4: нет перевода"]],
      [5, null, ["Строка 5: нет перевода"]],
    ]);
  });

  it("нет слова", () => {
    const result = parseCardTable("\tбыстрый\tпример");
    expect(result.rows[0]!.errors).toEqual(["Строка 1: нет слова или фразы по-английски"]);
  });

  it("лишние непустые столбцы — ошибка, лишние пустые — нет", () => {
    const result = parseCardTable("fast\tбыстрый\t\t\t\t\tнет\t\t\nbank\tбанк\t\t\t\t\tнет\tзаметка");
    expect(result.rows[0]!.errors).toEqual([]);
    expect(result.rows[1]!.card).toBeNull();
    expect(result.rows[1]!.errors).toEqual([
      "Строка 2: лишние столбцы после «можно без to»: «заметка». Возможно, в ячейке есть разделитель — возьмите её в кавычки",
    ]);
  });

  it("«можно без to»: да/нет, yes/no, 1/0, +/-, пусто", () => {
    const values = ["да", "Да", "yes", "1", "+", "TRUE", "нет", "no", "0", "-", "", "FALSE"];
    const text = values.map((value) => `to go\tидти\t\t\t\t\t${value}`).join("\n");
    expect(parseCardTable(text).rows.map((row) => row.card?.allowOmitTo)).toEqual([
      true, true, true, true, true, true, false, false, false, false, false, false,
    ]);
  });

  it("«можно без to»: непонятное значение", () => {
    const result = parseCardTable("to go\tидти\t\t\t\t\tможет");
    expect(result.rows[0]!.card).toBeNull();
    expect(result.rows[0]!.errors).toEqual([
      "Строка 1: столбец «можно без to»: ожидается да или нет, получено «может»",
    ]);
  });
});

describe("дополнительные ответы", () => {
  it("разбиваются по «;», обрезаются, без пустых, повторов и основного значения", () => {
    const result = parseCardTable("Fast\tБыстрый\t\t\t quick ; ;QUICK; fast ;rapid;;\tскорый; быстрый ;Скорый;шустрый");
    expect(result.rows[0]!.card).toMatchObject({
      acceptedRuEn: ["quick", "rapid"],
      acceptedEnRu: ["скорый", "шустрый"],
    });
  });

  it("повторы ищутся как при проверке ответа: пунктуация, ё, to при разрешённом пропуске", () => {
    const prepared = prepareCard({
      english: "to give up",
      translation: "сдаться",
      acceptedRuEn: "give up; Give up!; to quit; quit",
      acceptedEnRu: "сдаться!; сдаваться; сдаваться.",
      allowOmitTo: true,
    });
    expect(prepared.acceptedRuEn).toEqual(["to quit"]);
    expect(prepared.acceptedEnRu).toEqual(["сдаваться"]);

    const strict = prepareCard({ english: "to give up", translation: "сдаться", acceptedRuEn: "give up" });
    expect(strict.acceptedRuEn).toEqual(["give up"]);
  });
});

describe("дубли", () => {
  it("второе вхождение в импорте ссылается на первую строку; card заполнен", () => {
    const text = "bank\tбанк\nbank\tберег\n\n  BANK \tБанк\nbank\tберег";
    const result = parseCardTable(text);
    expect(result.rows.map((row) => [row.line, row.duplicate])).toEqual([
      [1, null],
      [2, null],
      [4, { kind: "in_import", line: 1 }],
      [5, { kind: "in_import", line: 2 }],
    ]);
    expect(result.rows[2]!.card).toEqual(card({ english: "BANK", translation: "Банк" }));
    expect(result.rows[2]!.errors).toEqual([]);
  });

  it("bank — банк и bank — берег не дубли; ё = е", () => {
    const result = parseCardTable("bank\tбанк\nbank\tберег\ngreen\tзелёный\ngreen\tзеленый");
    expect(result.rows.map((row) => row.duplicate)).toEqual([null, null, null, { kind: "in_import", line: 3 }]);
  });

  it("совпадение с существующими картами — existing, в том числе у повторов", () => {
    const result = parseCardTable("bank\tбанк\nbank\tберег\nBank\tбанк\nfast\tбыстрый", {
      existing: [
        { english: "bank", translation: "банк" },
        { english: "", translation: "пустая — пропускается" },
      ],
    });
    expect(result.rows.map((row) => row.duplicate)).toEqual([
      { kind: "existing" },
      null,
      { kind: "existing" },
      null,
    ]);
  });

  it("строка с ошибкой не участвует в поиске дублей", () => {
    const result = parseCardTable("bank\tбанк\t\t\t\t\tможет\nbank\tбанк");
    expect(result.rows[0]!.card).toBeNull();
    expect(result.rows[0]!.duplicate).toBeNull();
    expect(result.rows[1]!.duplicate).toBeNull();
  });
});

describe("правило «можно без to»", () => {
  it("допустимо только для текста, начинающегося с «to »", () => {
    expect(validateCard(card({ english: "to go", allowOmitTo: true }))).toEqual([]);
    expect(validateCard(card({ english: "To  Go", allowOmitTo: true }))).toEqual([]);
    for (const english of ["go", "today", "to", "toss up"]) {
      expect(validateCard(card({ english, allowOmitTo: true }))).toEqual([
        `отмечено «можно без to», но «${english}» не начинается с «to »: пропуск to подходит только для глаголов вида «to go»`,
      ]);
    }
  });

  it("в импорте", () => {
    const result = parseCardTable("go\tидти\t\t\t\t\tда");
    expect(result.rows[0]!.card).toBeNull();
    expect(result.rows[0]!.errors[0]).toMatch(/^Строка 1: отмечено «можно без to», но «go» не начинается с «to »/);
  });
});

describe("лимиты", () => {
  const long = (n: number, ch = "a") => ch.repeat(n);

  it("значения", () => {
    expect(CARD_LIMITS).toEqual({
      english: 100,
      translation: 100,
      example: 500,
      explanation: 500,
      acceptedItem: 100,
      acceptedCount: 20,
    });
  });

  it("ровно на границе — можно, на символ больше — ошибка", () => {
    expect(
      validateCard(
        card({
          english: long(100),
          translation: long(100, "я"),
          example: long(500),
          explanation: long(500),
          acceptedRuEn: Array.from({ length: 20 }, (_, i) => `${long(97)}${String(i).padStart(3, "0")}`),
          acceptedEnRu: [long(100, "я")],
        }),
      ),
    ).toEqual([]);
    expect(
      validateCard(
        card({
          english: long(101),
          translation: long(101, "я"),
          example: long(501),
          explanation: long(501),
          acceptedRuEn: Array.from({ length: 21 }, (_, i) => `w${i}`),
          acceptedEnRu: [long(101, "я")],
        }),
      ),
    ).toEqual([
      "слово или фраза длиннее 100 символов (сейчас 101)",
      "перевод длиннее 100 символов (сейчас 101)",
      "пример длиннее 500 символов (сейчас 501)",
      "пояснение длиннее 500 символов (сейчас 501)",
      "дополнительных ответов ru→en больше 20 (сейчас 21)",
      `дополнительный ответ en→ru «${long(40, "я")}…» длиннее 100 символов (сейчас 101)`,
    ]);
  });

  it("длина считается в символах, а не в единицах UTF-16", () => {
    expect(validateCard(card({ english: "🙂".repeat(100) }))).toEqual([]);
  });

  it("количество вариантов считается после удаления повторов", () => {
    const answers = Array.from({ length: 30 }, (_, i) => `quick${i % 20}`).join(";");
    const result = parseCardTable(`fast\tбыстрый\t\t\t${answers}`);
    expect(result.rows[0]!.card!.acceptedRuEn).toHaveLength(20);
  });

  it("в импорте ошибка с номером строки", () => {
    const result = parseCardTable(`fast\t${long(101, "б")}`);
    expect(result.rows[0]!.errors).toEqual(["Строка 1: перевод длиннее 100 символов (сейчас 101)"]);
  });
});

describe("maxRows", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => `word${i}\tслово${i}`).join("\n");

  it("по умолчанию 500, заголовок и пустые строки не считаются", () => {
    const exact = parseCardTable(`word\ttranslation\n\n${rows(500)}`);
    expect(exact.tooManyRows).toBe(false);
    expect(exact.rows).toHaveLength(500);

    const over = parseCardTable(rows(501));
    expect(over.tooManyRows).toBe(true);
    expect(over.rows).toHaveLength(500);
    expect(over.rows.at(-1)!.card!.english).toBe("word499");
  });

  it("свой предел", () => {
    const result = parseCardTable(rows(5), { maxRows: 3 });
    expect(result.tooManyRows).toBe(true);
    expect(result.rows.map((row) => row.line)).toEqual([1, 2, 3]);
    expect(parseCardTable(rows(3), { maxRows: 3 }).tooManyRows).toBe(false);
  });
});

describe("IMPORT_COLUMNS и схема", () => {
  it("порядок столбцов и обязательные", () => {
    expect(IMPORT_COLUMNS.map((column) => [column.key, column.required])).toEqual([
      ["english", true],
      ["translation", true],
      ["example", false],
      ["explanation", false],
      ["acceptedRuEn", false],
      ["acceptedEnRu", false],
      ["allowOmitTo", false],
    ]);
  });

  it("importedCardSchema применяет validateCard", () => {
    expect(importedCardSchema.safeParse(card()).success).toBe(true);
    const bad = importedCardSchema.safeParse(card({ translation: " " }));
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.map((issue) => issue.message)).toEqual(["нет перевода"]);
    expect(importedCardSchema.safeParse({ ...card(), extra: 1 }).success).toBe(false);
  });
});
