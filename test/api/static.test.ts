import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HEALTH_PATH, WEBHOOK_PATH } from "../../src/server/index.js";
import { buildTestApp } from "../helpers/api.js";
import { openTestDb } from "../helpers/db.js";
import { createFakeBot } from "../helpers/fake-telegram.js";

const { db, close } = openTestDb();
let dist: string;

beforeAll(async () => {
  dist = await mkdtemp(path.join(tmpdir(), "web-dist-"));
  await writeFile(path.join(dist, "index.html"), "<!doctype html><title>Кабинет</title>");
  await mkdir(path.join(dist, "assets"));
  await writeFile(path.join(dist, "assets", "app.js"), "console.log(1)");
});
afterAll(async () => {
  await rm(dist, { recursive: true, force: true });
  await close();
});

const html = { accept: "text/html,application/xhtml+xml" };

describe("раздача кабинета", () => {
  const app = () => buildTestApp(db, null, {}, { webDistDir: dist });

  it("отдаёт файлы сборки и index.html на главной", async () => {
    const server = app();
    expect((await server.inject({ url: "/assets/app.js" })).body).toContain("console.log");
    expect((await server.inject({ url: "/", headers: html })).body).toContain("Кабинет");
  });

  it("адрес страницы кабинета получает index.html", async () => {
    const response = await app().inject({ url: "/students/12", headers: html });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Кабинет");
    expect(response.headers["cache-control"]).toBe("no-cache");
  });

  it("не перехватывает /api, webhook, /health и отсутствующие файлы", async () => {
    const { bot } = createFakeBot(db);
    const server = buildTestApp(db, null, {}, { webDistDir: dist, webhook: { bot, secretToken: "s".repeat(32) } });
    const api = await server.inject({ url: "/api/unknown", headers: html });
    expect(api.statusCode).toBe(404);
    expect(api.json().error.code).toBe("not_found");
    expect((await server.inject({ url: "/api/auth/me", headers: html })).json().status).toBe("anonymous");
    expect((await server.inject({ url: "/api/dashboard", headers: html })).statusCode).toBe(401);
    expect((await server.inject({ url: HEALTH_PATH, headers: html })).json()).toEqual({ status: "ok" });
    expect((await server.inject({ method: "POST", url: WEBHOOK_PATH, payload: {} })).statusCode).toBe(401);
    expect((await server.inject({ url: WEBHOOK_PATH, headers: html })).statusCode).toBe(404);
    expect((await server.inject({ url: "/assets/missing.js", headers: html })).statusCode).toBe(404);
    expect((await server.inject({ url: "/students/12", headers: { accept: "application/json" } })).statusCode).toBe(404);
    expect((await server.inject({ method: "POST", url: "/students/12", headers: html })).statusCode).toBe(404);
  });

  it("обход каталога не выводит за папку сборки", async () => {
    const response = await app().inject({ url: "/..%2f..%2fpackage.json" });
    expect(response.statusCode).toBe(404);
  });

  it("без сборки API работает, а страниц нет", async () => {
    const server = buildTestApp(db, null);
    expect((await server.inject({ url: "/", headers: html })).statusCode).toBe(404);
    expect((await server.inject({ url: "/api/auth/me" })).statusCode).toBe(200);
  });
});
