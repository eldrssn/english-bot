import { expect, test } from "@playwright/test";
import { accounts, baseUrl } from "./env.js";
import {
  connectStudent,
  createStudent,
  expireCode,
  flashMessage,
  issueCollection,
  login,
  loginAsTeacher,
  studentJoinFails,
  studentJoins,
  studentRequestsNewCode,
  submitCode,
  uniqueName,
} from "./helpers.js";

const MAIN = baseUrl("main");

test.describe("Вход и выход", () => {
  test("аноним видит вход; ошибка входа показывается один раз", async ({ page }) => {
    await page.goto(`${MAIN}/?login_error=denied`);
    await expect(page.getByRole("heading", { level: 1, name: "Кабинет преподавателя" })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("Вход отменён в Telegram");
    await expect(page.getByRole("button", { name: "Войти через Telegram" })).toBeDisabled();
    await expect(page.getByRole("link", { name: "Вход для разработки" })).toBeVisible();
    await expect(page).toHaveURL(`${MAIN}/`);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Кабинет преподавателя" })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("вход преподавателя и выход; после выхода данных не видно", async ({ page }) => {
    await loginAsTeacher(page, "main");
    await expect(page.getByRole("navigation", { name: "Основное" }).getByRole("link", { name: "Ученики" })).toBeVisible();
    await page.getByRole("button", { name: "Выйти" }).click();
    await expect(page.getByRole("link", { name: "Вход для разработки" })).toBeVisible();
    await page.goto(`${MAIN}/students`);
    await expect(page.getByRole("link", { name: "Вход для разработки" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Ученики" })).toHaveCount(0);
  });

  test("аккаунт без роли видит только объяснение и свой Telegram ID", async ({ page, context }) => {
    const base = baseUrl("stranger");
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
    await login(page, "stranger");
    await expect(page.getByRole("heading", { level: 1, name: "Нет доступа к кабинету" })).toBeVisible();
    const id = String(accounts.stranger.telegramId);
    await expect(page.getByText(id, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Скопировать Telegram ID" }).click();
    await expect(page.getByText("Скопировано")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(id);
    await expect(page.getByRole("navigation")).toHaveCount(0);

    await page.goto(`${base}/students`);
    await expect(page.getByRole("heading", { level: 1, name: "Нет доступа к кабинету" })).toBeVisible();
    const status = await page.evaluate(async () => (await fetch("/api/students")).status);
    expect(status).toBe(401);

    await page.getByRole("button", { name: "Войти другим аккаунтом" }).click();
    await expect(page.getByRole("link", { name: "Вход для разработки" })).toBeVisible();
  });

  test("истёкшая сессия возвращает на вход с объяснением", async ({ page, context }) => {
    await loginAsTeacher(page, "main");
    await context.clearCookies();
    await page.getByRole("navigation", { name: "Основное" }).getByRole("link", { name: "Ученики" }).click();
    await expect(page.getByRole("alert")).toContainText("Сессия закончилась");
    await expect(page.getByRole("link", { name: "Вход для разработки" })).toBeVisible();
  });
});

test.describe("Ученик и ссылка", () => {
  test("имя обязательно; после создания видна ссылка, срок и предупреждение", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: MAIN });
    await loginAsTeacher(page, "main");
    await page.goto(`${MAIN}/students/new`);
    await page.getByRole("button", { name: "Создать и получить ссылку" }).click();
    await expect(page.getByRole("alert")).toHaveText("Введите имя ученика.");
    await expect(page.getByLabel("Имя ученика")).toHaveAttribute("aria-invalid", "true");

    const name = uniqueName("Мария");
    await page.getByLabel("Имя ученика").fill(name);
    await page.getByLabel("Имя ученика").press("Enter");
    const url = page.getByTestId("invite-url");
    await expect(url).toContainText("https://t.me/e2e_bot?start=");
    // Ссылка не содержит имя ученика.
    expect(await url.innerText()).not.toContain(name);
    await expect(page.getByText("Действует до")).toBeVisible();
    await expect(page.getByText("показать её снова нельзя")).toBeVisible();

    await page.getByRole("button", { name: "Скопировать ссылку" }).click();
    await expect(page.getByText("Скопировано")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await url.innerText());

    await page.getByRole("link", { name: "К списку учеников" }).click();
    const row = page.getByRole("row", { name: new RegExp(name) });
    await expect(row).toContainText("Ожидает подключения");
    await expect(row).toContainText("Ученик ещё не открыл ссылку");
    await expect(row).toContainText("Пока нет");
  });

  test("адрес ссылки потом не показывается; новая заменяет прежнюю; отмена закрывает ссылку", async ({ page }) => {
    await loginAsTeacher(page, "main");
    const student = await createStudent(page, "main");

    await page.goto(`${MAIN}/students/${student.id}`);
    await expect(page.getByText("Ссылка выдана и действует до")).toBeVisible();
    await expect(page.getByTestId("invite-url")).toHaveCount(0);
    await expect(page.getByText(student.url)).toHaveCount(0);

    await page.getByRole("button", { name: "Выдать новую ссылку" }).click();
    const fresh = await page.getByTestId("invite-url").innerText();
    expect(fresh).not.toBe(student.url);
    await studentJoinFails(student.url);

    await page.getByRole("button", { name: "Отменить ссылку" }).click();
    const dialog = page.getByRole("dialog", { name: "Отменить ссылку?" });
    await dialog.getByRole("button", { name: "Отменить ссылку" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("Прежняя ссылка отменена.")).toBeVisible();
    await expect(page.getByTestId("invite-url")).toHaveCount(0);
    await studentJoinFails(fresh);

    await page.goto(`${MAIN}/students`);
    await expect(page.getByRole("row", { name: new RegExp(student.name) })).toContainText("Выдать новую ссылку");
  });
});

test.describe("Заявка", () => {
  test("имя и username, предупреждение, неверный код с остатком, затем верный", async ({ page }) => {
    await loginAsTeacher(page, "main");
    const student = await createStudent(page, "main");
    const joined = await studentJoins(student.url, undefined, "Ирина Заявкина");

    await page.goto(`${MAIN}/`);
    const request = page.getByRole("listitem").filter({ hasText: student.name });
    await expect(request).toContainText("Ирина Заявкина");
    await request.getByRole("link", { name: /Проверить заявку/ }).click();
    await expect(page).toHaveURL(`${MAIN}/students/${student.id}/request`);

    await expect(page.getByTestId("request-name")).toHaveText("Ирина Заявкина");
    await expect(page.getByTestId("request-username")).toHaveText(`@${joined.username}`);
    await expect(page.getByText("не доказывают личность")).toBeVisible();
    await expect(page.getByText("в привычном канале")).toBeVisible();
    await expect(page.getByTestId("attempts-left")).toHaveText("Осталось 5 попыток");

    // Неполный код не тратит попытку.
    await submitCode(page, "12");
    await expect(page.getByRole("alert")).toContainText("Попытка не засчитана");
    await page.reload();
    await expect(page.getByTestId("attempts-left")).toHaveText("Осталось 5 попыток");

    const wrong = joined.code === "000000" ? "111111" : "000000";
    await submitCode(page, wrong);
    await expect(page.getByRole("alert")).toHaveText("Неверный код. Осталось 4 попытки.");
    await expect(page.getByLabel("Код из 6 цифр")).toBeFocused();

    await page.keyboard.type(joined.code);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${MAIN}/students/${student.id}`);
    await expect(flashMessage(page)).toContainText("Заявка подтверждена");
    await expect(page.getByText("Подключён", { exact: true })).toBeVisible();

    await page.goto(`${MAIN}/students`);
    const row = page.getByRole("row", { name: new RegExp(student.name) });
    await expect(row).toContainText("Подключён");
    await expect(row).toContainText("Ирина Заявкина");
    await expect(row).toContainText(`@${joined.username}`);
  });

  test("истёкший код: совет запросить новый в боте, новый код работает", async ({ page }) => {
    await loginAsTeacher(page, "main");
    const student = await createStudent(page, "main");
    const joined = await studentJoins(student.url);
    await page.goto(`${MAIN}/students/${student.id}/request`);
    await expect(page.getByLabel("Код из 6 цифр")).toBeEnabled();

    await expireCode(student.id);
    await submitCode(page, joined.code);
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("запросить новый код в боте");
    await expect(page.getByLabel("Код из 6 цифр")).toBeDisabled();

    const code = await studentRequestsNewCode(student.url, joined.telegramId);
    await page.getByRole("button", { name: "Обновить" }).click();
    await expect(page.getByLabel("Код из 6 цифр")).toBeEnabled();
    await submitCode(page, code);
    await expect(flashMessage(page)).toContainText("Заявка подтверждена");
  });

  test("исчерпанные попытки: старый код больше не принимается", async ({ page }) => {
    await loginAsTeacher(page, "other");
    const base = baseUrl("other");
    const student = await createStudent(page, "other");
    const joined = await studentJoins(student.url);
    await page.goto(`${base}/students/${student.id}/request`);
    const wrong = joined.code === "000000" ? "111111" : "000000";

    const left = ["Осталось 4 попытки", "Осталось 3 попытки", "Осталось 2 попытки", "Осталась 1 попытка"];
    for (const text of left) {
      await submitCode(page, wrong);
      await expect(page.getByRole("alert")).toHaveText(`Неверный код. ${text}.`);
    }
    await submitCode(page, wrong);
    await expect(page.getByRole("alert")).toContainText("закончились 5 попыток");
    await expect(page.getByRole("button", { name: "Подтвердить заявку" })).toBeDisabled();
  });

  test("отклонение: новая ссылка снова возможна", async ({ page }) => {
    await loginAsTeacher(page, "main");
    const student = await createStudent(page, "main");
    await studentJoins(student.url);
    await page.goto(`${MAIN}/students/${student.id}`);
    await expect(page.getByRole("heading", { level: 1, name: student.name })).toBeVisible();
    await expect(page.getByText("Сейчас убрать нельзя")).toBeVisible();
    await page.getByRole("link", { name: "Проверить заявку" }).click();

    await page.getByRole("button", { name: "Отклонить заявку" }).click();
    const dialog = page.getByRole("dialog", { name: "Отклонить заявку?" });
    await dialog.getByRole("button", { name: "Отклонить заявку" }).click();

    await expect(page).toHaveURL(`${MAIN}/students/${student.id}`);
    await expect(flashMessage(page)).toContainText("Заявка отклонена");
    await expect(page.getByText("Прежняя заявка отклонена.")).toBeVisible();
    await expect(page.getByText("Ожидает подключения", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Выдать новую ссылку" }).click();
    await expect(page.getByTestId("invite-url")).toContainText("https://t.me/e2e_bot?start=");
  });
});

test.describe("Карточка ученика", () => {
  test("подборки из API, смена имени", async ({ page }) => {
    await loginAsTeacher(page, "main");
    const student = await connectStudent(page, "main");
    await expect(page.getByText("Подборки этому ученику пока не выданы.")).toBeVisible();

    await issueCollection(student.id, "Глаголы движения");
    await page.reload();
    const item = page.getByRole("listitem").filter({ hasText: "Глаголы движения" });
    await expect(item).toContainText("Практикует");
    await expect(item).toContainText("0 слов");

    await page.getByRole("button", { name: "Изменить имя" }).click();
    const field = page.getByLabel("Новое имя");
    await expect(field).toBeFocused();
    await field.press("Escape");
    await expect(page.getByRole("button", { name: "Изменить имя" })).toBeFocused();

    const renamed = uniqueName("Переименованный");
    await page.getByRole("button", { name: "Изменить имя" }).click();
    await page.getByLabel("Новое имя").fill("   ");
    await page.getByRole("button", { name: "Сохранить имя" }).click();
    await expect(page.getByRole("alert")).toHaveText("Введите имя ученика.");
    await page.getByLabel("Новое имя").fill(renamed);
    await page.getByRole("button", { name: "Сохранить имя" }).click();
    await expect(page.getByRole("heading", { level: 1, name: renamed })).toBeVisible();
    await expect(page.getByText("Подключён", { exact: true })).toBeVisible();
  });

  test("отвязка: диалог с последствиями, Esc и фокус, после подтверждения записи нет", async ({ page }) => {
    await loginAsTeacher(page, "main");
    const student = await connectStudent(page, "main");

    const open = page.getByRole("button", { name: "Убрать из моих учеников" });
    await open.click();
    const dialog = page.getByRole("dialog", { name: /Убрать .* из моих учеников/ });
    await expect(dialog).toContainText("доступ к занятиям и результатам этого ученика прекратится");
    await expect(dialog).toContainText("сохранит прогресс и свои копии");
    await expect(dialog).toContainText("Новых материалов от вас он не получит");
    await expect(dialog.getByRole("button", { name: "Оставить" })).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(open).toBeFocused();
    await expect(page.getByText("Подключён", { exact: true })).toBeVisible();

    await open.click();
    await dialog.getByRole("button", { name: "Убрать из моих учеников" }).click();
    await expect(page).toHaveURL(`${MAIN}/students`);
    await expect(flashMessage(page)).toContainText("больше нет в вашем списке");
    await expect(page.getByRole("row", { name: new RegExp(student.name) })).toHaveCount(0);

    await page.goto(`${MAIN}/students/${student.id}`);
    await expect(page.getByText("Ученик не найден")).toBeVisible();
  });

  test("другой преподаватель не видит ученика, прямой адрес и запрос не открываются", async ({ page, browser }) => {
    await loginAsTeacher(page, "main");
    const student = await connectStudent(page, "main");

    const otherContext = await browser.newContext();
    const other = await otherContext.newPage();
    await loginAsTeacher(other, "other");
    const base = baseUrl("other");
    await other.goto(`${base}/students`);
    await expect(other.getByRole("heading", { level: 1, name: "Ученики" })).toBeVisible();
    await expect(other.getByText(student.name)).toHaveCount(0);

    await other.goto(`${base}/students/${student.id}`);
    await expect(other.getByText("Ученик не найден")).toBeVisible();
    await expect(other.getByText(student.name)).toHaveCount(0);

    await other.goto(`${base}/students/${student.id}/request`);
    await expect(other.getByText("Ученик не найден")).toBeVisible();

    const status = await other.evaluate(async (id) => (await fetch(`/api/students/${id}`)).status, student.id);
    expect(status).toBe(404);
    await otherContext.close();
  });
});

test.describe("Состояния загрузки и ошибки", () => {
  test("сбой сети: ошибка и повтор; медленный ответ: индикатор", async ({ page }) => {
    await loginAsTeacher(page, "main");
    await page.route("**/api/students", (route) => route.abort());
    await page.getByRole("navigation", { name: "Основное" }).getByRole("link", { name: "Ученики" }).click();
    await expect(page.getByRole("alert")).toContainText("Нет связи с сервером");

    await page.unroute("**/api/students");
    await page.route("**/api/students", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.continue();
    });
    await page.getByRole("button", { name: "Повторить" }).click();
    await expect(page.getByText("Загрузка…")).toBeVisible();
    await expect(page.getByRole("table", { name: "Ученики" })).toBeVisible();
  });

  test("несуществующая страница", async ({ page }) => {
    await loginAsTeacher(page, "main");
    await page.goto(`${MAIN}/nope`);
    await expect(page.getByRole("heading", { level: 1, name: "Страница не найдена" })).toBeVisible();
  });
});
