import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_DATABASE_URL, baseUrl, serverEnv, type AccountName } from "./env.js";

const run = promisify(execFile);

export async function login(page: Page, account: AccountName) {
  await page.goto(`${baseUrl(account)}/`);
  await page.getByRole("link", { name: "Вход для разработки" }).click();
}

export async function loginAsTeacher(page: Page, account: AccountName) {
  await login(page, account);
  await expect(page.getByRole("heading", { level: 1, name: "Главная" })).toBeVisible();
}

export type CreatedStudent = { id: number; name: string; url: string };

let nameCounter = 0;
export const uniqueName = (prefix: string) => `${prefix} ${Date.now() % 100000}-${++nameCounter}`;

/** Создаёт ученика через интерфейс. Заканчивает на экране со ссылкой. */
export async function createStudent(page: Page, account: AccountName, name = uniqueName("Ученик")): Promise<CreatedStudent> {
  await page.goto(`${baseUrl(account)}/students/new`);
  await page.getByLabel("Имя ученика").fill(name);
  await page.getByRole("button", { name: "Создать и получить ссылку" }).click();
  const url = await page.getByTestId("invite-url").innerText();
  const href = await page.getByRole("link", { name: "Открыть карточку ученика" }).getAttribute("href");
  const id = Number(href?.split("/").at(-1));
  expect(id).toBeGreaterThan(0);
  return { id, name, url };
}

let telegramCounter = 0;
export const uniqueTelegramId = () => 800000000 + (Date.now() % 1000000) * 10 + (++telegramCounter % 10);

/** Ученик подтверждает ссылку в «боте». Настоящий скрипт разработки, настоящая база. */
export async function studentJoins(url: string, telegramId = uniqueTelegramId(), name = "Тестовый Ученик") {
  const { stdout } = await run(process.execPath, ["--import", "tsx", "scripts/dev-student.ts", url, String(telegramId), name], {
    env: { ...process.env, ...serverEnv },
  });
  const code = /Код: (\d{6})/.exec(stdout)?.[1];
  if (!code) throw new Error(`Код не получен: ${stdout}`);
  return { code, telegramId, name, username: `student${telegramId}` };
}

/** Повторная попытка по той же ссылке: скрипт отказывает, если ссылка больше не действует. */
export async function studentJoinFails(url: string) {
  await expect(
    run(process.execPath, ["--import", "tsx", "scripts/dev-student.ts", url, String(uniqueTelegramId()), "Посторонний"], {
      env: { ...process.env, ...serverEnv },
    }),
  ).rejects.toThrow();
}

/** Новый код к существующей заявке: как кнопка в боте. */
export async function studentRequestsNewCode(url: string, telegramId: number) {
  const { stdout } = await run(process.execPath, ["--import", "tsx", "scripts/dev-student.ts", url, String(telegramId), "Тестовый Ученик"], {
    env: { ...process.env, ...serverEnv },
  });
  const code = /код: (\d{6})/i.exec(stdout)?.[1];
  if (!code) throw new Error(`Код не получен: ${stdout}`);
  return code;
}

export async function submitCode(page: Page, code: string) {
  await page.getByLabel("Код из 6 цифр").fill(code);
  await page.getByRole("button", { name: "Подтвердить заявку" }).click();
}

/** Полная привязка: ссылка, заявка, верный код. Заканчивает на карточке подключённого ученика. */
export async function connectStudent(page: Page, account: AccountName, name?: string) {
  const student = await createStudent(page, account, name);
  const joined = await studentJoins(student.url);
  await page.goto(`${baseUrl(account)}/students/${student.id}/request`);
  await submitCode(page, joined.code);
  await expect(page.getByText("Подключён", { exact: true })).toBeVisible();
  return { ...joined, ...student };
}

async function withDb<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** Код истёк: сдвигаем срок в базе, ждать 24 часа тест не может. */
export const expireCode = (studentId: number) =>
  withDb((client) =>
    client.query(
      "UPDATE invitations SET code_expires_at = now() - interval '1 minute' WHERE student_link_id = $1 AND status = 'awaiting_teacher'",
      [studentId],
    ),
  );

/** Выданной подборки через интерфейс ещё нет (этап 4), поэтому копия создаётся прямо в базе. */
export const issueCollection = (studentId: number, title: string, status = "practicing") =>
  withDb(async (client) => {
    const source = await client.query<{ id: number }>(
      "INSERT INTO source_collections (teacher_user_id, title) SELECT teacher_user_id, $2 FROM student_links WHERE id = $1 RETURNING id",
      [studentId, title],
    );
    await client.query(
      "INSERT INTO student_collections (student_link_id, source_collection_id, title, status) VALUES ($1, $2, $3, $4)",
      [studentId, source.rows[0]?.id, title, status],
    );
  });

/** Создаёт подборку через интерфейс; заканчивает на её странице. */
export async function createCollection(page: Page, account: AccountName, title = uniqueName("Подборка")) {
  await page.goto(`${baseUrl(account)}/collections/new`);
  await page.getByLabel("Название подборки").fill(title);
  await page.getByRole("button", { name: "Создать подборку" }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  const id = Number(new URL(page.url()).pathname.split("/").at(-1));
  expect(id).toBeGreaterThan(0);
  return { id, title };
}

export type Card = { english: string; translation: string; example?: string; allowOmitTo?: boolean };

/** Быстрое наполнение подборки через API (ручной ввод проверяется отдельным сценарием). */
export async function addCards(page: Page, collectionId: number, cards: Card[]) {
  const statuses = await page.evaluate(
    async ({ id, list }) => {
      const me = await (await fetch("/api/auth/me")).json();
      const result: number[] = [];
      for (const card of list) {
        const response = await fetch(`/api/collections/${id}/cards`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-csrf-token": me.csrfToken },
          body: JSON.stringify(card),
        });
        result.push(response.status);
      }
      return result;
    },
    { id: collectionId, list: cards },
  );
  expect(statuses.every((status) => status === 200)).toBe(true);
}

/** Сообщение о результате действия в шапке страницы (а не индикатор загрузки или другие живые области). */
export const flashMessage = (page: Page) => page.getByRole("status", { name: "Сообщение о результате" });
