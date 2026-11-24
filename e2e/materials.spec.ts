// Этап 4: подборки, карточки, импорт, выдача, копии учеников.
import { expect, test, type Page } from "@playwright/test";
import { baseUrl } from "./env.js";
import { addCards, connectStudent, createCollection, createStudent, flashMessage, loginAsTeacher, uniqueName, type Card } from "./helpers.js";

const MAIN = baseUrl("main");

const TRAVEL: Card[] = [
  { english: "to go", translation: "идти", allowOmitTo: true },
  { english: "ticket", translation: "билет" },
  { english: "luggage", translation: "багаж" },
];

const rowOf = (page: Page, table: string, word: string) => page.getByRole("table", { name: table }).getByRole("row").filter({ hasText: word });

test.describe("Подборка и карточки", () => {
  test("пустой список ведёт к созданию; название обязательно", async ({ page }) => {
    await loginAsTeacher(page, "main");
    await page.getByRole("navigation", { name: "Основное" }).getByRole("link", { name: "Подборки" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Подборки" })).toBeVisible();
    await page.goto(`${MAIN}/collections/new`);
    await expect(page.getByLabel("Название подборки")).toBeFocused();
    await page.getByRole("button", { name: "Создать подборку" }).click();
    await expect(page.getByRole("alert")).toHaveText("Введите название подборки.");

    const { title } = await createCollection(page, "main");
    await expect(flashMessage(page)).toContainText(`Подборка «${title}» создана`);
    await expect(page.getByText("В подборке пока нет карточек")).toBeVisible();
    await page.getByRole("link", { name: "Все подборки" }).click();
    const row = page.getByRole("table", { name: "Подборки" }).getByRole("row", { name: new RegExp(title) });
    await expect(row).toContainText("Никому");
  });

  test("карточка с ошибкой и без, серия добавлений, дубль, предпросмотр, правка, порядок, удаление", async ({ page }) => {
    await loginAsTeacher(page, "main");
    const collection = await createCollection(page, "main");
    await page.getByRole("link", { name: "Добавить карточку" }).first().click();
    const english = page.getByLabel("Слово или фраза по-английски");
    await expect(english).toBeFocused();

    // Ошибки формы: пустой перевод и «можно без to» у слова без to. Ничего не сохраняется.
    await english.fill("walk");
    await page.getByLabel("Можно отвечать без «to»").check();
    await page.getByRole("button", { name: "Добавить карточку" }).click();
    await expect(page.getByText("Нет перевода.")).toBeVisible();
    await expect(page.getByText(/не начинается с «to »/)).toBeVisible();
    await expect(page.getByLabel("Основной перевод")).toBeFocused();
    await expect(page.getByLabel("Основной перевод")).toHaveAttribute("aria-invalid", "true");

    // Исправленная карточка сохраняется, форма очищается, фокус в первом поле.
    await page.getByLabel("Можно отвечать без «to»").uncheck();
    await page.getByLabel("Основной перевод").fill("гулять");
    await page.getByLabel("Пример (необязательно)").fill("We walk in the park.");
    await page.getByLabel("Другие верные ответы по-русски (en→ru)").fill("ходить; ходить пешком");
    const preview = page.getByRole("region", { name: "Как увидит ученик" });
    await expect(preview).toContainText("walk — гулять");
    await expect(preview).toContainText("We walk in the park.");
    await expect(preview).toContainText("гулять; ходить; ходить пешком");
    await page.getByRole("button", { name: "Добавить карточку" }).click();
    await expect(page.getByRole("status").filter({ hasText: "добавлена" })).toContainText("Карточка «walk — гулять» добавлена");
    await expect(english).toBeFocused();
    await expect(english).toHaveValue("");

    await english.fill("bank");
    await page.getByLabel("Основной перевод").fill("банк");
    await page.getByRole("button", { name: "Добавить карточку" }).click();
    await expect(english).toHaveValue("");
    // Вопросы в обе стороны: с двумя словами в подборке у бота уже есть неверный вариант.
    await english.fill("bank");
    await page.getByLabel("Основной перевод").fill("берег");
    await expect(preview).toContainText("Выберите перевод на английский:\nберег");
    await expect(preview).toContainText("Выберите перевод на русский:\nbank");
    await expect(preview.getByRole("list", { name: "Кнопки: Вопрос en→ru" })).toContainText("гулять");
    await page.getByRole("button", { name: "Добавить карточку" }).click();
    await expect(english).toHaveValue("");

    // Дубль: та же пара с другим регистром и пробелами.
    await english.fill(" Bank ");
    await page.getByLabel("Основной перевод").fill("БАНК");
    await expect(page.getByText(/В подборке уже есть карточка «bank — банк»/)).toBeVisible();
    await page.getByRole("button", { name: "Добавить карточку" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "уже есть карточка" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Добавлено сейчас: 3" })).toBeVisible();

    await page.getByRole("link", { name: "Готово, к подборке" }).click();
    const table = page.getByRole("table", { name: "Карточки подборки" });
    await expect(table.getByRole("row")).toHaveCount(4);
    await expect(rowOf(page, "Карточки подборки", "walk")).toContainText("ходить; ходить пешком");

    // Порядок кнопками, фокус остаётся на кнопке.
    await page.getByRole("button", { name: "Ниже: walk" }).click();
    await expect(page.getByRole("button", { name: "Ниже: walk" })).toBeFocused();
    await expect(table.getByRole("row").nth(2)).toContainText("walk");
    await page.reload();
    await expect(page.getByRole("table", { name: "Карточки подборки" }).getByRole("row").nth(2)).toContainText("walk");

    // Правка.
    await page.getByRole("link", { name: "Изменить: bank — берег" }).click();
    await page.getByLabel("Пояснение (необязательно)").fill("берег реки");
    await page.getByRole("button", { name: "Сохранить карточку" }).click();
    await expect(page).toHaveURL(`${MAIN}/collections/${collection.id}`);
    await expect(flashMessage(page)).toContainText("Карточка «bank — берег» сохранена");
    await expect(rowOf(page, "Карточки подборки", "bank").filter({ hasText: "берег" })).toContainText("берег реки");

    // Правка в дубль отклоняется.
    await page.getByRole("link", { name: "Изменить: bank — берег" }).click();
    await page.getByLabel("Основной перевод").fill("банк");
    await page.getByRole("button", { name: "Сохранить карточку" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "уже есть карточка" })).toBeVisible();
    await page.getByRole("link", { name: "Отмена" }).click();

    // Удаление с подтверждением.
    await page.getByRole("button", { name: "Удалить: walk — гулять" }).click();
    const dialog = page.getByRole("dialog", { name: /Удалить карточку «walk — гулять»/ });
    await expect(dialog).toContainText("Копии, которые ученики уже получили, не изменятся");
    await expect(dialog.getByRole("button", { name: "Оставить" })).toBeFocused();
    await dialog.getByRole("button", { name: "Удалить карточку" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("table", { name: "Карточки подборки" }).getByRole("row")).toHaveCount(3);

    // Переименование.
    await page.getByRole("button", { name: "Переименовать" }).click();
    const renamed = uniqueName("Новое имя подборки");
    await page.getByLabel("Новое название").fill(renamed);
    await page.getByRole("button", { name: "Сохранить название" }).click();
    await expect(page.getByRole("heading", { level: 1, name: renamed })).toBeVisible();
    await expect(page.getByRole("button", { name: "Переименовать" })).toBeFocused();
  });

  test("импорт с ошибками и дублями: до подтверждения ничего не сохраняется", async ({ page }) => {
    await loginAsTeacher(page, "main");
    const collection = await createCollection(page, "main");
    await addCards(page, collection.id, [{ english: "ticket", translation: "билет" }]);
    await page.goto(`${MAIN}/collections/${collection.id}/import`);

    await page.getByText("Порядок столбцов и пример").click();
    await expect(page.getByText("Слово или фраза по-английски", { exact: false }).first()).toBeVisible();

    const text = [
      "Слово\tПеревод\tПример",
      "suitcase\tчемодан\tMy suitcase is heavy.",
      "ticket\tбилет",
      "\tбез слова",
      "platform\tплатформа",
      "Suitcase\tЧемодан",
      "walk\tгулять\t\t\t\t\tда",
    ].join("\n");
    await page.getByLabel("Строки из таблицы").fill(text);
    const preview = page.getByRole("region", { name: "Предпросмотр" });
    await expect(preview.getByText("Будет добавлено")).toBeVisible();
    await expect(preview.locator(".stat").nth(0)).toContainText("2");
    await expect(preview.locator(".stat").nth(1)).toContainText("2");
    await expect(preview.locator(".stat").nth(2)).toContainText("2");
    await expect(preview).toContainText("Первая строка — названия столбцов");
    const rows = preview.getByRole("table", { name: "Строки вставки" });
    await expect(rows.getByRole("row").filter({ hasText: "ticket" })).toContainText("Такая карточка уже есть в подборке");
    await expect(rows.getByRole("row").filter({ hasText: /^6/ })).toContainText("Повтор строки 2");
    await expect(rows.getByRole("row").filter({ hasText: /^4/ })).toContainText("Нет слова или фразы по-английски");
    await expect(rows.getByRole("row").filter({ hasText: /^7/ })).toContainText("не начинается с «to »");

    await page.getByLabel("Показывать только строки с ошибками и дубли").check();
    await expect(rows.getByRole("row")).toHaveCount(5);

    // Без подтверждения в подборке по-прежнему одна карточка.
    const before = await page.evaluate(async (id) => (await (await fetch(`/api/collections/${id}`)).json()).cards.length, collection.id);
    expect(before).toBe(1);

    await page.getByRole("button", { name: "Добавить 2 карточки" }).click();
    await expect(page.getByText("Добавлено: 2 карточки. Пропущено: с ошибками — 2, дублей — 2.")).toBeVisible();
    await expect(page.getByLabel("Строки из таблицы")).toHaveValue("");
    await page.getByRole("link", { name: "Открыть подборку" }).click();
    await expect(page.getByRole("table", { name: "Карточки подборки" }).getByRole("row")).toHaveCount(4);
  });

  test("файл CSV в Windows-1251 читается с предупреждением", async ({ page }) => {
    await loginAsTeacher(page, "main");
    const collection = await createCollection(page, "main");
    await page.goto(`${MAIN}/collections/${collection.id}/import`);
    // «hello;привет» в cp1251.
    const cp1251 = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x3b, 0xef, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x0a]);
    await page.getByLabel("Или файл CSV").setInputFiles({ name: "words.csv", mimeType: "text/csv", buffer: cp1251 });
    await expect(page.getByText(/прочитали его как Windows-1251/)).toBeVisible();
    await expect(page.getByRole("table", { name: "Строки вставки" })).toContainText("привет");
  });
});

test.describe("Выдача и копии", () => {
  test("выдача двум ученикам с предпросмотром, добавление в копию, новая версия, «Забрать», удаление подборки", async ({ page }) => {
    await loginAsTeacher(page, "main");
    const active = await connectStudent(page, "main");
    const pending = await createStudent(page, "main");
    const collection = await createCollection(page, "main");
    await addCards(page, collection.id, TRAVEL);
    await page.reload();

    await page.getByRole("link", { name: "Выдать ученикам" }).click();
    await page.getByRole("checkbox", { name: active.name }).check();
    await page.getByRole("checkbox", { name: pending.name }).check();
    await page.getByRole("button", { name: "Проверить, что получат: 2 ученика" }).click();

    const message = `Новая подборка: ${collection.title}. Слов: 3. Посмотрите карточки и начните практику.`;
    const activeItem = page.getByRole("listitem").filter({ hasText: active.name });
    const pendingItem = page.getByRole("listitem").filter({ hasText: pending.name });
    await expect(activeItem).toContainText("Получит сразу");
    await expect(activeItem).toContainText(message);
    await expect(pendingItem).toContainText("Получит после подключения");
    await expect(pendingItem).toContainText(message);
    await page.getByRole("button", { name: "Выдать: 2 ученика" }).click();
    await expect(page.getByRole("heading", { name: "Готово" })).toBeVisible();
    await expect(activeItem).toContainText("Выдана, уведомление уходит сейчас");
    await expect(pendingItem).toContainText("уведомление придёт после подключения");

    // Повторная выдача: уже выдана, второй копии нет.
    await page.getByRole("button", { name: "Выдать ещё кому-то" }).click();
    await page.getByRole("checkbox", { name: active.name }).check();
    await page.getByRole("button", { name: /Проверить, что получат/ }).click();
    await expect(activeItem).toContainText("Уже выдана, второй копии не будет");
    await expect(page.getByRole("button", { name: "Выдавать некому" })).toBeDisabled();

    // Копия подключённого ученика: из карточки ученика.
    await page.goto(`${MAIN}/students/${active.id}`);
    await page.getByRole("link", { name: collection.title }).click();
    await expect(page.getByRole("heading", { level: 1, name: collection.title })).toBeVisible();
    const copyUrl = page.url();
    await expect(page.getByRole("table", { name: "Карточки копии" }).getByRole("row")).toHaveCount(4);

    // Добавление в копию формой: предупреждение с точным текстом уведомления.
    await page.getByRole("link", { name: "Добавить карточки" }).click();
    await expect(page.getByText(`В подборку добавлены слова: ${collection.title}. Новых карточек: 1.`)).toBeVisible();
    await page.getByLabel("Слово или фраза по-английски").fill("platform");
    await page.getByLabel("Основной перевод").fill("платформа");
    await page.getByRole("button", { name: "Добавить в копию" }).click();
    await expect(page.getByRole("status").filter({ hasText: "добавлена" })).toContainText("Ученик получит уведомление");
    // Дубль в копии.
    await page.getByLabel("Слово или фраза по-английски").fill("ticket");
    await page.getByLabel("Основной перевод").fill("билет");
    await expect(page.getByText(/В копии уже есть карточка «ticket — билет»/)).toBeVisible();

    // Вставка в копию.
    await page.getByRole("button", { name: "Вставить из таблицы" }).click();
    await page.getByLabel("Строки из таблицы").fill("gate\tвыход\nticket\tбилет");
    await expect(page.getByText(`Новых карточек: 1.`)).toBeVisible();
    await page.getByRole("button", { name: "Добавить в копию: 1 карточка" }).click();
    await expect(page.getByText(/Добавлено: 1 карточка\. Пропущено: с ошибками — 0, дублей — 1\./)).toBeVisible();

    await page.goto(copyUrl);
    const copyTable = page.getByRole("table", { name: "Карточки копии" });
    await expect(copyTable.getByRole("row")).toHaveCount(6);
    await expect(rowOf(page, "Карточки копии", "platform")).toContainText("новая");

    // Правка: новая версия с пояснением.
    await page.getByRole("link", { name: "Изменить: ticket — билет" }).click();
    await expect(page.getByText("Сохранение создаст версию 2")).toBeVisible();
    await expect(page.getByText("Сохранённые ответы не пересчитываются")).toBeVisible();
    await page.getByRole("button", { name: "Сохранить новую версию" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Изменений нет" })).toBeVisible();
    await page.getByLabel("Пример (необязательно)").fill("Show me your ticket.");
    await page.getByRole("button", { name: "Сохранить новую версию" }).click();
    await expect(flashMessage(page)).toContainText("сохранена, версия 2");
    await expect(rowOf(page, "Карточки копии", "ticket")).toContainText("Show me your ticket.");

    // Копия другого ученика и оригинал не изменились.
    const otherCopy = await page.evaluate(async (id) => {
      const student = await (await fetch(`/api/students/${id}`)).json();
      const copy = await (await fetch(`/api/copies/${student.collections[0].id}`)).json();
      return copy.cards.map((card: { english: string; example: string | null }) => `${card.english}:${card.example ?? ""}`);
    }, pending.id);
    expect(otherCopy).toEqual(["to go:", "ticket:", "luggage:"]);
    const source = await page.evaluate(
      async (id) => (await (await fetch(`/api/collections/${id}`)).json()).cards.map((card: { example: string | null }) => card.example),
      collection.id,
    );
    expect(source).toEqual([null, null, null]);

    // Удаление карточки копии.
    await page.getByRole("button", { name: "Удалить: luggage — багаж" }).click();
    const deleteDialog = page.getByRole("dialog");
    await expect(deleteDialog).toContainText("История ответов сохранится");
    await deleteDialog.getByRole("button", { name: "Удалить карточку" }).click();
    await expect(copyTable.getByRole("row")).toHaveCount(5);
    await expect(page.getByRole("heading", { name: /Карточки/ })).toBeFocused();

    // Забрать у ученика.
    await page.getByRole("button", { name: "Забрать у ученика" }).click();
    const withdraw = page.getByRole("dialog", { name: /Забрать/ });
    await expect(withdraw).toContainText("исчезнет из бота ученика");
    await expect(withdraw).toContainText("История ответов сохранится");
    await withdraw.getByRole("button", { name: "Забрать у ученика" }).click();
    await expect(page).toHaveURL(`${MAIN}/students/${active.id}`);
    await expect(flashMessage(page)).toContainText("забрана у ученика");
    await expect(page.getByRole("link", { name: collection.title })).toHaveCount(0);
    await page.goto(copyUrl);
    await expect(page.getByText("Копия не найдена")).toBeVisible();

    // Удаление подборки: копия второго ученика остаётся.
    await page.goto(`${MAIN}/collections/${collection.id}`);
    await page.getByRole("button", { name: "Удалить подборку" }).click();
    const deleteCollection = page.getByRole("dialog", { name: /Удалить подборку/ });
    await expect(deleteCollection).toContainText("Копии останутся у учеников (1 ученик)");
    await deleteCollection.getByRole("button", { name: "Удалить подборку" }).click();
    await expect(page).toHaveURL(`${MAIN}/collections`);
    await expect(flashMessage(page)).toContainText(`Подборка «${collection.title}» удалена`);
    await expect(page.getByRole("link", { name: collection.title })).toHaveCount(0);
    await page.goto(`${MAIN}/collections/${collection.id}`);
    await expect(page.getByText("Подборка не найдена")).toBeVisible();
    await page.goto(`${MAIN}/students/${pending.id}`);
    await expect(page.getByRole("link", { name: collection.title })).toBeVisible();
  });

  test("чужой преподаватель не видит подборки и копии по прямому адресу", async ({ page, browser }) => {
    await loginAsTeacher(page, "main");
    const student = await connectStudent(page, "main");
    const collection = await createCollection(page, "main");
    await addCards(page, collection.id, TRAVEL);
    const copyId = await page.evaluate(
      async ({ id, studentId }) => {
        const me = await (await fetch("/api/auth/me")).json();
        const response = await fetch(`/api/collections/${id}/issue`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-csrf-token": me.csrfToken },
          body: JSON.stringify({ studentIds: [studentId] }),
        });
        return (await response.json()).results[0].copyId as number;
      },
      { id: collection.id, studentId: student.id },
    );
    const cardId = await page.evaluate(async (id) => (await (await fetch(`/api/collections/${id}`)).json()).cards[0].id, collection.id);

    const otherContext = await browser.newContext();
    const other = await otherContext.newPage();
    await loginAsTeacher(other, "other");
    const base = baseUrl("other");
    await other.goto(`${base}/collections`);
    await expect(other.getByRole("heading", { level: 1, name: "Подборки" })).toBeVisible();
    await expect(other.getByText(collection.title)).toHaveCount(0);

    for (const path of [`/collections/${collection.id}`, `/collections/${collection.id}/import`, `/collections/${collection.id}/issue`, `/collections/${collection.id}/cards/${cardId}`]) {
      await other.goto(`${base}${path}`);
      await expect(other.getByText("Подборка не найдена")).toBeVisible();
      await expect(other.getByText(collection.title)).toHaveCount(0);
    }
    await other.goto(`${base}/copies/${copyId}`);
    await expect(other.getByText("Копия не найдена")).toBeVisible();
    await other.goto(`${base}/copies/${copyId}/add`);
    await expect(other.getByText("Копия не найдена")).toBeVisible();

    const statuses = await other.evaluate(
      async ({ collectionId, copyId: copy }) => [
        (await fetch(`/api/collections/${collectionId}`)).status,
        (await fetch(`/api/copies/${copy}`)).status,
      ],
      { collectionId: collection.id, copyId },
    );
    expect(statuses).toEqual([404, 404]);
    await otherContext.close();
  });
});
