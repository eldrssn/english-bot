// Этап 7: результаты ученика и подборки, выгрузка CSV, доступ только своему преподавателю.
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { baseUrl } from "./env.js";
import { addCards, connectStudent, createCollection, issueThroughApi, loginAsTeacher, studentPractices, uniqueName } from "./helpers.js";

const BASE = baseUrl("results");

async function checkPage(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${label}: горизонтальная прокрутка`).toBeLessThanOrEqual(0);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  const problems = results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`);
  expect(problems, `${label}: нарушения доступности`).toEqual([]);
}

/** Подключённый ученик, подборка с формулой среди карточек, выдача и пройденный тест (apple — дважды неверно). */
async function studentWithResults(page: Page) {
  await loginAsTeacher(page, "results");
  const student = await connectStudent(page, "results", uniqueName("Результат"));
  const collection = await createCollection(page, "results", uniqueName("Подборка результатов"));
  await addCards(page, collection.id, [
    { english: "apple", translation: "яблоко" },
    { english: "bank", translation: "банк" },
    { english: "bank", translation: "берег" },
    { english: "cat", translation: "кошка" },
    { english: "=SUM(1;2)", translation: "формула" },
  ]);
  await issueThroughApi(page, collection.id, [student.id]);
  const output = await studentPractices(student.telegramId, ["apple"]);
  expect(output).toContain("стали сложными: apple");
  return { student, collection };
}

test.describe("Результаты", () => {
  test("страница ученика: сводка, занятия, ответы обеих попыток, сложные слова; фильтры; CSV для Excel", async ({ page }) => {
    const { student, collection } = await studentWithResults(page);

    await page.goto(`${BASE}/students/${student.id}`);
    await expect(page.getByRole("heading", { name: "Результаты" })).toBeVisible();
    await page.getByRole("link", { name: "Открыть результаты" }).click();
    await expect(page.getByRole("heading", { level: 1, name: `Результаты: ${student.name}` })).toBeVisible();
    await expect(page.getByText("Прежние связи с этим учеником сюда не входят")).toBeVisible();

    const stats = page.locator("dl.stats");
    await expect(stats.getByText("Изучено слов")).toBeVisible();
    await expect(stats.locator(".stat", { hasText: "Сложные слова" }).locator("dd")).toHaveText("1");
    await expect(stats.locator(".stat", { hasText: "Верно с первой попытки" }).locator("dd")).toHaveText("4 из 5 (80%)");

    const sessions = page.getByRole("region", { name: "Занятия ученика" });
    await expect(sessions.getByRole("row", { name: new RegExp(`Тест: ${collection.title}`) })).toContainText("Завершено");

    const answers = page.getByRole("region", { name: "Ответы ученика" });
    const appleRow = answers.getByRole("row", { name: /apple — яблоко/ });
    await expect(appleRow).toContainText("стало сложным");
    await expect(appleRow.getByText("Неверно")).toHaveCount(2);
    await expect(answers.getByRole("row", { name: /bank — берег/ })).toContainText("Верно");

    const words = page.getByRole("region", { name: "Слова ученика" });
    await expect(words.getByRole("row")).toHaveCount(6);
    await page.getByLabel("Показать").selectOption("hard");
    await expect(words.getByRole("row")).toHaveCount(2);
    await expect(words.getByRole("row", { name: /apple — яблоко/ })).toContainText("Сложное");

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: "Скачать CSV" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^Результаты .+ \d{4}-\d{2}-\d{2}\.csv$/);
    const bytes = await readFile((await download.path())!);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.toString("utf8");
    expect(text).toContain(`Результаты ученика;${student.name}`);
    expect(text).toContain(`"'=SUM(1;2)"`);
    expect(text).not.toMatch(/(^|;|\r\n)=/);
    expect(text).toContain("\r\n");
  });

  test("страница подборки: кто получил и завершил, трудные слова; главная показывает последние результаты", async ({ page }) => {
    const { student, collection } = await studentWithResults(page);

    await page.goto(`${BASE}/collections/${collection.id}`);
    await page.getByRole("link", { name: "Результаты по подборке" }).click();
    await expect(page.getByRole("heading", { level: 1, name: `Результаты: ${collection.title}` })).toBeVisible();
    await expect(page.locator(".stat", { hasText: "Завершили" }).locator("dd")).toHaveText("1");
    const recipients = page.getByRole("region", { name: "Ученики, получившие подборку" });
    await expect(recipients.getByRole("row", { name: new RegExp(student.name) })).toContainText("Завершил");
    const difficult = page.getByRole("region", { name: "Трудные слова подборки" });
    await expect(difficult.getByRole("row", { name: /apple — яблоко/ })).toBeVisible();
    await expect(difficult.getByRole("row", { name: /cat — кошка/ })).toHaveCount(0);

    await recipients.getByRole("link", { name: student.name }).click();
    await expect(page.getByRole("heading", { level: 1, name: `Результаты: ${student.name}` })).toBeVisible();

    await page.goto(`${BASE}/`);
    const recent = page.getByRole("region", { name: "Последние результаты" });
    await expect(recent.getByRole("link", { name: `Результаты: ${student.name}` }).first()).toBeVisible();
    await expect(recent).toContainText(`Тест: ${collection.title} — с первой попытки 4 из 5 (80%)`);
    const issued = page.getByRole("region", { name: "Недавно выданные подборки" });
    await expect(issued.getByRole("link", { name: collection.title }).first()).toBeVisible();
  });

  test("другой преподаватель: страница результатов, CSV и результаты подборки не открываются", async ({ page, browser }) => {
    const { student, collection } = await studentWithResults(page);
    const otherContext = await browser.newContext();
    const other = await otherContext.newPage();
    await loginAsTeacher(other, "other");
    const base = baseUrl("other");

    await other.goto(`${base}/students/${student.id}/results`);
    await expect(other.getByText("Ученик не найден")).toBeVisible();
    await expect(other.getByText(student.name)).toHaveCount(0);
    await other.goto(`${base}/collections/${collection.id}/results`);
    await expect(other.getByText("Подборка не найдена")).toBeVisible();

    const statuses = await other.evaluate(
      async ({ id, collectionId }) =>
        Promise.all(
          [`/api/students/${id}/results`, `/api/students/${id}/results/csv`, `/api/collections/${collectionId}/results`].map(
            async (url) => (await fetch(url)).status,
          ),
        ),
      { id: student.id, collectionId: collection.id },
    );
    expect(statuses).toEqual([404, 404, 404]);
    await otherContext.close();
  });

  test.describe("на телефоне", () => {
    test.use({ viewport: { width: 375, height: 812 } });
    test("страницы результатов без прокрутки вбок и без нарушений axe", async ({ page }) => {
      const { student, collection } = await studentWithResults(page);
      await page.goto(`${BASE}/students/${student.id}/results`);
      await expect(page.getByRole("region", { name: "Ответы ученика" })).toBeVisible();
      await checkPage(page, "результаты ученика");
      await page.goto(`${BASE}/collections/${collection.id}/results`);
      await expect(page.getByRole("region", { name: "Трудные слова подборки" })).toBeVisible();
      await checkPage(page, "результаты подборки");
    });
  });

  test.describe("тёмная тема", () => {
    test.use({ colorScheme: "dark" });
    test("страница результатов без нарушений axe", async ({ page }) => {
      const { student } = await studentWithResults(page);
      await page.goto(`${BASE}/students/${student.id}/results`);
      await expect(page.getByRole("region", { name: "Слова ученика" })).toBeVisible();
      await checkPage(page, "результаты ученика, тёмная тема");
    });
  });
});
