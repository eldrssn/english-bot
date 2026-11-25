import { existsSync } from "node:fs";
import path from "node:path";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { webhookCallback } from "grammy";
import type { Bot } from "grammy";
import type { BotContext } from "../bot/context.js";
import type { Db } from "../db/client.js";
import type { Logger } from "../logger.js";
import { errorBody } from "./api/errors.js";
import { registerApi, type ApiOptions } from "./api/index.js";

export const HEALTH_PATH = "/health";
export const WEBHOOK_PATH = "/telegram/webhook";
const API_PREFIX = "/api";

export type BuildServerOptions = {
  db: Db;
  /** Журнал запросов и ошибок. Без него сервер молчит (так работают тесты). */
  logger?: Logger;
  /** Если задано, принимаем webhook с проверкой секретного токена. Иначе маршрута нет: локально работает опрос. */
  webhook?: { bot: Bot<BotContext>; secretToken: string };
  /** Если задано, работает API кабинета. */
  api?: ApiOptions;
  /** Папка сборки кабинета. Если index.html в ней нет, статика не раздаётся. */
  webDistDir?: string;
  /** Число прокси перед сервисом. Адрес клиента берётся по числу прокси, поэтому подделка X-Forwarded-For не обходит лимиты. */
  proxyHops?: number;
};

export type RegisteredRoute = { method: string; url: string };

declare module "fastify" {
  interface FastifyInstance {
    /** Все объявленные маршруты: тесты прав перебирают именно их, чтобы новый маршрут не остался без проверки. */
    registeredRoutes: RegisteredRoute[];
  }
}

/** Адрес страницы кабинета, а не запрос файла и не служебный маршрут. */
function isSpaNavigation(method: string, url: string, accept: string | undefined): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const pathname = url.split("?")[0] ?? "";
  if (pathname === HEALTH_PATH || pathname.startsWith("/telegram/")) return false;
  if (pathname.split("/").at(-1)?.includes(".")) return false;
  return accept?.includes("text/html") ?? false;
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  if (options.api?.isProduction && options.api.devLoginTelegramId !== null) {
    throw new Error("Вход для разработки запрещён при NODE_ENV=production");
  }

  const proxyHops = options.proxyHops ?? 0;
  const app = Fastify({
    // Тип журнала Fastify уже, чем у pino: приводим, чтобы экземпляр сервера остался обычным FastifyInstance.
    ...(options.logger ? { loggerInstance: options.logger as FastifyBaseLogger } : { logger: false }),
    trustProxy: (_address: string, hop: number) => hop < proxyHops,
  });

  // Общий обработчик для всего, кроме API (у API свой, с кодами ошибок кабинета): webhook, health, статика.
  // Подробности уходят в журнал, клиенту — только общий ответ. 500 на webhook заставляет Telegram повторить событие.
  app.setErrorHandler((error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      request.log.warn({ err: error }, "Запрос отклонён");
      return reply.code(status).send({ error: "Bad Request" });
    }
    request.log.error({ err: error }, "Необработанная ошибка запроса");
    return reply.code(500).send({ error: "Internal Server Error" });
  });

  app.decorate("registeredRoutes", [] as RegisteredRoute[]);
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) app.registeredRoutes.push({ method, url: route.url });
  });

  app.get(HEALTH_PATH, async (_request, reply) => {
    try {
      await options.db.execute(sql`SELECT 1`);
      return { status: "ok" };
    } catch (error) {
      app.log.error(error, "Проверка базы не прошла");
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  if (options.webhook) {
    const { bot, secretToken } = options.webhook;
    app.post(WEBHOOK_PATH, webhookCallback(bot, "fastify", { secretToken }));
  }

  const api = options.api;
  if (api) {
    void app.register(fastifyCookie);
    void app.register(async (scope) => registerApi(scope, options.db, api));
  }

  const distDir = options.webDistDir ? path.resolve(options.webDistDir) : null;
  const hasWebBuild = distDir !== null && existsSync(path.join(distDir, "index.html"));
  if (hasWebBuild) {
    // wildcard: false — маршруты только для файлов сборки; всё остальное решает обработчик ниже.
    void app.register(fastifyStatic, { root: distDir, wildcard: false });
  }

  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split("?")[0] ?? "";
    if (pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`)) {
      return reply.code(404).send(errorBody("not_found"));
    }
    if (hasWebBuild && isSpaNavigation(request.method, request.url, request.headers.accept)) {
      return reply.header("cache-control", "no-cache").sendFile("index.html", { cacheControl: false });
    }
    return reply.code(404).send({ error: "Not Found" });
  });

  return app;
}
