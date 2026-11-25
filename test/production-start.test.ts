// Этап 7: запуск в режиме размещения (NODE_ENV=production, webhook) без настоящего Telegram.
// Сервис поднимается настоящим src/main.ts; Bot API заменён локальным HTTP-сервером (TELEGRAM_API_ROOT),
// поэтому ни один запрос не уходит наружу. Проверяется то, что делает Railway: health, webhook с секретом,
// журнал в JSON без секретов и мягкая остановка по SIGTERM.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, openTestDb, resetDb } from "./helpers/db.js";
import { textUpdate } from "./helpers/fake-telegram.js";

const { db, close } = openTestDb();
beforeEach(() => resetDb(db));
afterAll(close);

const BOT_TOKEN = "123456:PROD-TEST-TOKEN";
const WEBHOOK_SECRET = "w".repeat(40);
const APP_SECRET = "p".repeat(40);

type ApiCall = { method: string; body: Record<string, unknown> };

/** Локальный Bot API: отвечает на getMe и запоминает остальные вызовы. */
async function fakeBotApi() {
  const calls: ApiCall[] = [];
  const server: Server = createServer(async (request: IncomingMessage, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const method = request.url?.split("/").at(-1) ?? "";
    calls.push({ method, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
    const result =
      method === "getMe"
        ? { id: 123456, is_bot: true, first_name: "Тестовый бот", username: "test_bot" }
        : method === "sendMessage"
          ? { message_id: calls.length, date: 0, chat: { id: 1, type: "private" }, text: "ok" }
          : true;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { calls, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

let child: ChildProcess | null = null;
let api: Awaited<ReturnType<typeof fakeBotApi>> | null = null;
afterEach(async () => {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  child = null;
  await api?.close();
  api = null;
});

describe("запуск для размещения", () => {
  it("webhook с секретом, health, журнал JSON без секретов, мягкая остановка", async () => {
    api = await fakeBotApi();
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "production",
        BOT_TOKEN,
        BOT_MODE: "webhook",
        WEBHOOK_SECRET,
        DATABASE_URL: TEST_DATABASE_URL,
        APP_SECRET,
        WEB_BASE_URL: "https://cabinet.example",
        TELEGRAM_LOGIN_CLIENT_ID: "client",
        TELEGRAM_LOGIN_CLIENT_SECRET: "client-secret",
        TELEGRAM_API_ROOT: api.url,
        PORT: String(port),
        HOST: "127.0.0.1",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr!.on("data", (chunk) => (stderr += String(chunk)));
    const exited = new Promise<number | null>((resolve) => child!.on("exit", (code) => resolve(code)));

    // Ждём, пока сервис зарегистрирует webhook: это последний шаг запуска.
    for (let i = 0; i < 150 && !api.calls.some((call) => call.method === "setWebhook"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(api.calls.find((call) => call.method === "setWebhook")?.body, stderr).toMatchObject({
      url: "https://cabinet.example/telegram/webhook",
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
    });

    expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: "ok" });

    const update = JSON.stringify(textUpdate(5559, "/start"));
    const headers = { "content-type": "application/json" };
    const unsigned = await fetch(`${base}/telegram/webhook`, { method: "POST", headers, body: update });
    expect(unsigned.status).toBe(401);
    const signed = await fetch(`${base}/telegram/webhook`, {
      method: "POST",
      headers: { ...headers, "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
      body: update,
    });
    expect(signed.status).toBe(200);
    expect(api.calls.some((call) => call.method === "sendMessage" && call.body.chat_id === 5559)).toBe(true);

    // Кабинет в production: вход для разработки выключен, cookie с Secure появятся только после настоящего входа.
    expect((await fetch(`${base}/api/auth/dev-login`)).status).toBe(404);

    child.kill("SIGTERM");
    expect(await exited).toBe(0);

    const lines = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => typeof line.level === "string" && typeof line.message === "string")).toBe(true);
    expect(lines.map((line) => line.message)).toEqual(expect.arrayContaining(["Webhook зарегистрирован", "Остановка сервиса"]));
    for (const secret of [BOT_TOKEN, WEBHOOK_SECRET, APP_SECRET, "client-secret"]) expect(stdout + stderr).not.toContain(secret);
    expect(stderr).toBe("");
  }, 30_000);
});
