// Этап 4: исходные подборки преподавателя, карточки, порядок и импорт через HTTP API.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sourceCards, sourceCollections, studentCollections } from "../../src/db/schema.js";
import {
  apiError,
  apiRoutes,
  importPreviewResponse,
  importResponse,
  sourceCardResponse,
  sourceCollectionDetail,
  sourceCollectionsResponse,
} from "../../src/shared/api-contract.js";
import { createFakeOidc, type FakeOidc } from "../helpers/api.js";
import { at, cardInput, connectedStudent, createCollection, issueTo, teacherSession } from "../helpers/cabinet.js";
import { openTestDb, resetDb } from "../helpers/db.js";

const { db, close } = openTestDb();
afterAll(close);
beforeEach(() => resetDb(db));

let oidc: FakeOidc;
beforeAll(async () => {
  oidc = await createFakeOidc();
});

const TEACHER = 91001;
const STUDENT = 91101;

const teacher = () => teacherSession(db, oidc, TEACHER);

describe("исходные подборки", () => {
  it("создание, список с числом карточек и выдач, переименование, просмотр", async () => {
    const { browser } = await teacher();
    expect(sourceCollectionsResponse.parse((await browser.get(apiRoutes.listCollections.path)).json())).toEqual({ collections: [] });

    const created = await createCollection(browser, "  Еда  ", [cardInput("bread", "хлеб"), cardInput("milk", "молоко")]);
    expect(created.title).toBe("Еда");
    expect(created.cards.map((c) => [c.english, c.translation, c.position])).toEqual([
      ["bread", "хлеб", 0],
      ["milk", "молоко", 1],
    ]);

    const student = await connectedStudent(db, browser, STUDENT);
    expect((await issueTo(browser, created.id, [student.id])).statusCode).toBe(200);

    const list = sourceCollectionsResponse.parse((await browser.get(apiRoutes.listCollections.path)).json());
    expect(list.collections).toEqual([expect.objectContaining({ id: created.id, title: "Еда", cardCount: 2, issuedCount: 1 })]);

    const renamed = await browser.send("PATCH", at(apiRoutes.renameCollection, created.id), { title: "Продукты" });
    expect(sourceCollectionDetail.parse(renamed.json()).title).toBe("Продукты");
    // Название выданной копии не меняется вместе с оригиналом.
    expect((await db.select().from(studentCollections))[0]!.title).toBe("Еда");

    for (const title of ["", "   ", "x".repeat(201)]) {
      expect((await browser.send("PATCH", at(apiRoutes.renameCollection, created.id), { title })).statusCode).toBe(400);
    }
  });

  it("удаление: подборка пропадает из списка и недоступна, выданные копии остаются у учеников", async () => {
    const { browser } = await teacher();
    const created = await createCollection(browser, "Еда", [cardInput("bread", "хлеб")]);
    const student = await connectedStudent(db, browser, STUDENT);
    await issueTo(browser, created.id, [student.id]);

    expect((await browser.send("DELETE", at(apiRoutes.deleteCollection, created.id))).json()).toEqual({ ok: true });
    expect(sourceCollectionsResponse.parse((await browser.get(apiRoutes.listCollections.path)).json()).collections).toEqual([]);
    expect((await browser.get(at(apiRoutes.getCollection, created.id))).statusCode).toBe(404);
    expect((await issueTo(browser, created.id, [student.id])).statusCode).toBe(404);
    expect((await browser.send("DELETE", at(apiRoutes.deleteCollection, created.id))).statusCode).toBe(404);

    const [copy] = await db.select().from(studentCollections);
    expect(copy?.deletedAt).toBeNull();
    const detail = await browser.get(at(apiRoutes.getStudent, student.id));
    expect(detail.json().collections).toEqual([expect.objectContaining({ id: copy!.id, wordCount: 1, sourceCollectionId: created.id })]);
    const [source] = await db.select().from(sourceCollections);
    expect(source?.deletedAt).not.toBeNull();
  });
});

describe("карточки исходной подборки", () => {
  it("поля проверяются общими правилами: обрезка, варианты через «;», ошибки по-русски", async () => {
    const { browser } = await teacher();
    const { id } = await createCollection(browser, "Глаголы", []);
    const added = await browser.send("POST", at(apiRoutes.addCollectionCard, id), {
      english: "  to   go ",
      translation: " идти ",
      example: "  ",
      acceptedRuEn: "go; to go ;  ",
      acceptedEnRu: ["ходить", "идти"],
      allowOmitTo: true,
    });
    expect(added.statusCode, added.body).toBe(200);
    expect(sourceCardResponse.parse(added.json()).card).toMatchObject({
      english: "to go",
      translation: "идти",
      example: null,
      explanation: null,
      acceptedEnRu: ["ходить"],
      allowOmitTo: true,
    });

    const invalid = await browser.send("POST", at(apiRoutes.addCollectionCard, id), {
      english: "",
      translation: "x".repeat(101),
      allowOmitTo: true,
    });
    expect(invalid.statusCode).toBe(422);
    const error = apiError.parse(invalid.json()).error;
    expect(error.code).toBe("invalid_card");
    expect(error.details).toEqual(expect.arrayContaining([expect.stringContaining("нет слова"), expect.stringContaining("перевод длиннее 100")]));
    expect((await db.select().from(sourceCards)).length).toBe(1);

    // Тело неверной формы — 400, до проверки карточки.
    expect((await browser.send("POST", at(apiRoutes.addCollectionCard, id), { english: 1 })).statusCode).toBe(400);
  });

  it("дубль (то же слово и перевод) не добавляется и не получается правкой; другой перевод добавляется", async () => {
    const { browser } = await teacher();
    const created = await createCollection(browser, "Слова", [cardInput("bank", "банк"), cardInput("river", "река")]);
    const duplicate = await browser.send("POST", at(apiRoutes.addCollectionCard, created.id), cardInput(" Bank ", "БАНК"));
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("duplicate_card");
    expect((await browser.send("POST", at(apiRoutes.addCollectionCard, created.id), cardInput("bank", "берег"))).statusCode).toBe(200);

    const river = created.cards.find((c) => c.english === "river")!;
    const editToDuplicate = await browser.send("PATCH", at(apiRoutes.editSourceCard, river.id), cardInput("bank", "банк"));
    expect(editToDuplicate.statusCode).toBe(409);
    // Правка самой себя дублем не считается.
    const bank = created.cards.find((c) => c.english === "bank")!;
    const self = await browser.send("PATCH", at(apiRoutes.editSourceCard, bank.id), cardInput("bank", "банк", { example: "a bank" }));
    expect(sourceCardResponse.parse(self.json()).card.example).toBe("a bank");
  });

  it("правка оригинала на месте не меняет выданную копию; удаление скрывает карточку, освобождая пару", async () => {
    const { browser } = await teacher();
    const created = await createCollection(browser, "Слова", [cardInput("cat", "кот"), cardInput("dog", "собака")]);
    const student = await connectedStudent(db, browser, STUDENT);
    const issued = (await issueTo(browser, created.id, [student.id])).json().results[0];

    const cat = created.cards.find((c) => c.english === "cat")!;
    await browser.send("PATCH", at(apiRoutes.editSourceCard, cat.id), cardInput("cat", "кошка"));
    await browser.send("DELETE", at(apiRoutes.deleteSourceCard, created.cards.find((c) => c.english === "dog")!.id));

    const source = sourceCollectionDetail.parse((await browser.get(at(apiRoutes.getCollection, created.id))).json());
    expect(source.cards.map((c) => `${c.english}—${c.translation}`)).toEqual(["cat—кошка"]);
    expect(source.cardCount).toBe(1);
    const copy = (await browser.get(at(apiRoutes.getCopy, issued.copyId))).json();
    expect(copy.cards.map((c: { english: string; translation: string }) => `${c.english}—${c.translation}`)).toEqual(["cat—кот", "dog—собака"]);

    // Удалённую карточку не изменить и не удалить повторно; её пару снова можно добавить.
    const dogId = created.cards.find((c) => c.english === "dog")!.id;
    expect((await browser.send("PATCH", at(apiRoutes.editSourceCard, dogId), cardInput("dog", "пёс"))).statusCode).toBe(404);
    expect((await browser.send("DELETE", at(apiRoutes.deleteSourceCard, dogId))).statusCode).toBe(404);
    expect((await browser.send("POST", at(apiRoutes.addCollectionCard, created.id), cardInput("dog", "собака"))).statusCode).toBe(200);
  });

  it("порядок: присланы все действующие карточки ровно по разу, иначе 409 и ничего не меняется", async () => {
    const { browser } = await teacher();
    const created = await createCollection(browser, "Слова", [cardInput("a1", "а1"), cardInput("b2", "б2"), cardInput("c3", "в3")]);
    const [a, b, c] = created.cards.map((card) => card.id) as [number, number, number];

    const reordered = await browser.send("PUT", at(apiRoutes.reorderCollectionCards, created.id), { cardIds: [c, a, b] });
    expect(sourceCollectionDetail.parse(reordered.json()).cards.map((card) => card.english)).toEqual(["c3", "a1", "b2"]);

    for (const cardIds of [[c, a], [c, a, b, b], [c, a, 999999], []]) {
      const response = await browser.send("PUT", at(apiRoutes.reorderCollectionCards, created.id), { cardIds });
      expect(response.statusCode, JSON.stringify(cardIds)).toBe(409);
      expect(response.json().error.code).toBe("state_changed");
    }
    // Новая карточка встаёт в конец.
    await browser.send("POST", at(apiRoutes.addCollectionCard, created.id), cardInput("d4", "г4"));
    const detail = sourceCollectionDetail.parse((await browser.get(at(apiRoutes.getCollection, created.id))).json());
    expect(detail.cards.map((card) => card.english)).toEqual(["c3", "a1", "b2", "d4"]);
  });
});

describe("импорт", () => {
  const TABLE = [
    "Слово\tПеревод\tПример\tПояснение\tОтветы ru→en\tОтветы en→ru\tМожно без to",
    "apple\tяблоко\tAn apple a day.\t\t\t\t",
    "\tгруша\t\t\t\t\t", // нет слова
    "to run\tбежать\t\t\tsprint\tбегать\tда",
    "bread\tхлеб\t\t\t\t\t", // уже есть в подборке
    "apple\tяблоко\t\t\t\t\t", // повтор строки 2
    "go\tидти\t\t\t\t\tда", // без to — ошибка
    "plum\tслива\t\t\t\t\t",
  ].join("\n");

  async function withBread() {
    const { browser } = await teacher();
    const collection = await createCollection(browser, "Фрукты", [cardInput("bread", "хлеб")]);
    return { browser, collection };
  }

  it("предпросмотр показывает ошибки и дубли по строкам и ничего не сохраняет", async () => {
    const { browser, collection } = await withBread();
    const response = await browser.send("POST", at(apiRoutes.importPreview, collection.id), { text: TABLE });
    expect(response.statusCode, response.body).toBe(200);
    const preview = importPreviewResponse.parse(response.json());
    expect(preview).toMatchObject({ delimiter: "tab", hasHeader: true, tooManyRows: false, toAdd: 3, invalid: 2, duplicates: 2 });
    const byLine = new Map(preview.rows.map((row) => [row.line, row]));
    expect(byLine.get(3)!.errors[0]).toMatch(/^Строка 3: /);
    expect(byLine.get(5)!.duplicate).toEqual({ kind: "existing" });
    expect(byLine.get(6)!.duplicate).toEqual({ kind: "in_import", line: 2 });
    expect(byLine.get(4)!.card).toMatchObject({ english: "to run", acceptedRuEn: ["sprint"], acceptedEnRu: ["бегать"], allowOmitTo: true });
    expect(byLine.get(7)!.card).toBeNull();

    expect((await db.select().from(sourceCards))).toHaveLength(1);
  });

  it("сохранение: только строки без ошибок и не дубли, сразу все; повтор ничего не добавляет", async () => {
    const { browser, collection } = await withBread();
    const response = await browser.send("POST", at(apiRoutes.importCards, collection.id), { text: TABLE });
    expect(response.statusCode, response.body).toBe(200);
    const saved = importResponse.parse(response.json());
    expect(saved).toMatchObject({ added: 3, skippedInvalid: 2, skippedDuplicates: 2 });
    expect(saved.collection.cards.map((card) => card.english)).toEqual(["bread", "apple", "to run", "plum"]);
    expect(saved.collection.cards.map((card) => card.position)).toEqual([0, 1, 2, 3]);

    const again = importResponse.parse((await browser.send("POST", at(apiRoutes.importCards, collection.id), { text: TABLE })).json());
    expect(again).toMatchObject({ added: 0, skippedInvalid: 2, skippedDuplicates: 5 });
    expect(await db.select().from(sourceCards)).toHaveLength(4);
  });

  it("подделанный клиент: сервер разбирает текст сам, лишние поля и чужие «готовые строки» не принимаются", async () => {
    const { browser, collection } = await withBread();
    // Клиент «подтверждает» предпросмотр, где ошибочная строка помечена как годная: сервер её не возьмёт.
    const forged = await browser.send("POST", at(apiRoutes.importCards, collection.id), {
      text: "\tгруша\nbread\tхлеб",
      rows: [{ line: 1, card: { english: "hack", translation: "взлом" }, errors: [], duplicate: null }],
      toAdd: 2,
    });
    expect(forged.statusCode).toBe(200);
    expect(importResponse.parse(forged.json())).toMatchObject({ added: 0, skippedInvalid: 1, skippedDuplicates: 1 });
    const english = (await db.select().from(sourceCards)).map((card) => card.english);
    expect(english).toEqual(["bread"]);

    // Строки сверх лимита: ничего не сохраняется.
    const many = Array.from({ length: 501 }, (_, index) => `w${index}\tслово ${index}`).join("\n");
    const tooMany = await browser.send("POST", at(apiRoutes.importCards, collection.id), { text: many });
    expect(tooMany.statusCode).toBe(422);
    expect(tooMany.json().error.code).toBe("import_too_large");
    expect(await db.select().from(sourceCards)).toHaveLength(1);
    const preview = importPreviewResponse.parse((await browser.send("POST", at(apiRoutes.importPreview, collection.id), { text: many })).json());
    expect(preview.tooManyRows).toBe(true);
  });

  it("500 строк с длинными примерами по-русски (больше 1 МБ) принимаются целиком", async () => {
    const { browser, collection } = await withBread();
    const long = "примерный ".repeat(49).trim();
    const answers = (index: number) => Array.from({ length: 5 }, (_, n) => `ответ${n} ${"ж".repeat(80)} ${index}`).join("; ");
    const text = Array.from({ length: 500 }, (_, index) => `word${index}\tслово ${index}\t${long}\t${long}\t\t${answers(index)}`).join("\n");
    expect(Buffer.byteLength(JSON.stringify({ text }))).toBeGreaterThan(1024 * 1024);
    const saved = await browser.send("POST", at(apiRoutes.importCards, collection.id), { text });
    expect(saved.statusCode, saved.body.slice(0, 200)).toBe(200);
    expect(importResponse.parse(saved.json()).added).toBe(500);
  });

  it("CSV с «;» и кавычками; файл с BOM", async () => {
    const { browser, collection } = await withBread();
    const csv = '﻿english;translation;example\n"well-known";"известный";"A ""well-known"" fact; really"\n';
    const saved = importResponse.parse((await browser.send("POST", at(apiRoutes.importCards, collection.id), { text: csv })).json());
    expect(saved.added).toBe(1);
    expect(saved.collection.cards[1]).toMatchObject({ english: "well-known", example: 'A "well-known" fact; really' });
  });

  it("импорт в чужую или удалённую подборку: 404", async () => {
    const { browser, collection } = await withBread();
    await browser.send("DELETE", at(apiRoutes.deleteCollection, collection.id));
    expect((await browser.send("POST", at(apiRoutes.importPreview, collection.id), { text: TABLE })).statusCode).toBe(404);
    expect((await browser.send("POST", at(apiRoutes.importCards, collection.id), { text: TABLE })).statusCode).toBe(404);
    expect(await db.select().from(sourceCards).where(eq(sourceCards.collectionId, collection.id))).toHaveLength(1);
  });
});
