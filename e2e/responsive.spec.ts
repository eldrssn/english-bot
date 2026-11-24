// Вёрстка и доступность: 375 px и компьютер, светлая и тёмная тема, автоматическая проверка axe.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { baseUrl, type AccountName } from "./env.js";
import { addCards, createCollection, createStudent, flashMessage, issueCollection, loginAsTeacher, studentJoins, submitCode, uniqueName } from "./helpers.js";

const BASE = baseUrl("responsive");

async function checkPage(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${label}: горизонтальная прокрутка`).toBeLessThanOrEqual(0);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  const problems = results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`);
  expect(problems, `${label}: нарушения доступности`).toEqual([]);
}

// Счётчик запусков: каждая комбинация создаёт своих учеников.
const combos: { name: string; account: AccountName; viewport: { width: number; height: number }; colorScheme: "light" | "dark" }[] = [
  { name: "телефон, светлая тема", account: "phoneLight", viewport: { width: 375, height: 812 }, colorScheme: "light" },
  { name: "телефон, тёмная тема", account: "phoneDark", viewport: { width: 375, height: 812 }, colorScheme: "dark" },
  { name: "компьютер, светлая тема", account: "desktopLight", viewport: { width: 1280, height: 800 }, colorScheme: "light" },
  { name: "компьютер, тёмная тема", account: "desktopDark", viewport: { width: 1280, height: 800 }, colorScheme: "dark" },
];

test("пустое состояние ведёт к первому шагу", async ({ page }) => {
  await loginAsTeacher(page, "responsive");
  await expect(page.getByRole("link", { name: "Добавить ученика" })).toBeVisible();
  await page.goto(`${BASE}/students`);
  await expect(page.getByText("В списке пока никого нет")).toBeVisible();
  await page.getByRole("link", { name: "Добавить первого ученика" }).click();
  await expect(page.getByLabel("Имя ученика")).toBeFocused();
});

for (const combo of combos) {
  test.describe(combo.name, () => {
    test.use({ viewport: combo.viewport, colorScheme: combo.colorScheme });
    const BASE = baseUrl(combo.account);

    test("главные экраны без прокрутки вбок и без нарушений axe; действия доступны", async ({ page }) => {
      await page.goto(`${BASE}/?login_error=failed`);
      await expect(page.getByRole("alert")).toBeVisible();
      await checkPage(page, "вход");

      await loginAsTeacher(page, combo.account);
      await checkPage(page, "главная");

      // Длинное имя не должно ломать вёрстку.
      const longName = `${uniqueName("Константинопольская-Преображенская")} ${"очень-длинное-имя".repeat(4)}`;
      const student = await createStudent(page, combo.account, longName);
      await checkPage(page, "ссылка");

      const joined = await studentJoins(student.url, undefined, "Анастасия Константинопольская");
      await page.goto(`${BASE}/`);
      await page.getByRole("link", { name: /Проверить заявку/ }).first().click();
      await expect(page.getByLabel("Код из 6 цифр")).toBeVisible();
      await checkPage(page, "заявка");

      await submitCode(page, joined.code === "000000" ? "111111" : "000000");
      await expect(page.getByRole("alert")).toContainText("Неверный код");
      await checkPage(page, "заявка с ошибкой");

      await page.goto(`${BASE}/students/${student.id}/request`);
      await submitCode(page, joined.code);
      await expect(flashMessage(page)).toContainText("Заявка подтверждена");
      await issueCollection(student.id, "Подборка с длинным названием о путешествиях и транспорте");
      await page.reload();
      await expect(page.getByRole("heading", { name: "Выданные подборки" })).toBeVisible();
      await checkPage(page, "карточка");

      await page.getByRole("button", { name: "Убрать из моих учеников" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await checkPage(page, "диалог отвязки");
      await page.keyboard.press("Escape");

      await page.goto(`${BASE}/students`);
      await expect(page.getByRole("table", { name: "Ученики" })).toBeVisible();
      await checkPage(page, "список");
    });

    test("экраны подборок и копий без прокрутки вбок и без нарушений axe", async ({ page }) => {
      await loginAsTeacher(page, combo.account);
      await page.goto(`${BASE}/collections`);
      await expect(page.getByRole("heading", { level: 1, name: "Подборки" })).toBeVisible();
      await checkPage(page, "список подборок");

      const collection = await createCollection(page, combo.account, `${uniqueName("Путешествия-и-транспорт")} с длинным названием`);
      await checkPage(page, "пустая подборка");
      await addCards(page, collection.id, [
        { english: "to look forward to", translation: "ждать с нетерпением", example: "I look forward to our trip to the mountains.", allowOmitTo: true },
        { english: "accommodation", translation: "жильё, размещение" },
        { english: "bank", translation: "берег" },
      ]);
      await page.reload();
      await expect(page.getByRole("table", { name: "Карточки подборки" })).toBeVisible();
      await checkPage(page, "подборка с карточками");

      await page.getByRole("button", { name: "Удалить подборку" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await checkPage(page, "диалог удаления подборки");
      await page.keyboard.press("Escape");

      await page.goto(`${BASE}/collections/${collection.id}/cards/new`);
      await page.getByLabel("Слово или фраза по-английски").fill("walk");
      await page.getByLabel("Основной перевод").fill("гулять");
      await page.getByLabel("Можно отвечать без «to»").check();
      await expect(page.getByRole("region", { name: "Как увидит ученик" })).toContainText("walk — гулять");
      await checkPage(page, "форма карточки с ошибкой и предпросмотр");

      await page.goto(`${BASE}/collections/${collection.id}/import`);
      await page.getByText("Порядок столбцов и пример").click();
      await page.getByLabel("Строки из таблицы").fill("word\tслово\nbank\tберег\n\tбез слова\nan-extraordinarily-long-english-expression-without-spaces\tочень-длинный-перевод-без-пробелов");
      await expect(page.getByRole("table", { name: "Строки вставки" })).toBeVisible();
      await checkPage(page, "импорт с предпросмотром");

      const student = await createStudent(page, combo.account);
      await page.goto(`${BASE}/collections/${collection.id}/issue`);
      await page.getByRole("checkbox", { name: student.name }).check();
      await checkPage(page, "выдача: выбор");
      await page.getByRole("button", { name: /Проверить, что получат/ }).click();
      await expect(page.getByText("Получит после подключения")).toBeVisible();
      await checkPage(page, "выдача: предпросмотр");
      await page.getByRole("button", { name: /Выдать:/ }).click();
      await expect(page.getByRole("heading", { name: "Готово" })).toBeVisible();
      await checkPage(page, "выдача: результат");

      await page.getByRole("link", { name: `Копия ученика ${student.name}` }).click();
      await expect(page.getByRole("table", { name: "Карточки копии" })).toBeVisible();
      await checkPage(page, "копия ученика");
      await page.getByRole("button", { name: "Забрать у ученика" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await checkPage(page, "диалог «Забрать»");
      await page.keyboard.press("Escape");

      await page.getByRole("link", { name: "Добавить карточки" }).click();
      await page.getByRole("button", { name: "Вставить из таблицы" }).click();
      await page.getByLabel("Строки из таблицы").fill("gate\tвыход");
      await expect(page.getByRole("table", { name: "Строки вставки" })).toBeVisible();
      await checkPage(page, "добавление в копию");

      await page.goto(`${BASE}/students/${student.id}`);
      await checkPage(page, "карточка ученика с копией");
    });
  });
}

test.describe("нет доступа", () => {
  test.use({ viewport: { width: 375, height: 812 } });
  test("экран на телефоне", async ({ page }) => {
    await page.goto(`${baseUrl("stranger")}/`);
    await page.getByRole("link", { name: "Вход для разработки" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Нет доступа к кабинету" })).toBeVisible();
    await checkPage(page, "нет доступа");
  });
});
