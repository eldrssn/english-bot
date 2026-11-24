// Клиент API кабинета. Адреса, тела и ответы описаны только в общем контракте; здесь их нет.
import type { z } from "zod";
import { CSRF_HEADER, apiError, apiRoutes, type ApiErrorCode, type ApiRoutes, type MeResponse } from "../../shared/api-contract";

type FetchRouteKey = {
  [K in keyof ApiRoutes]: ApiRoutes[K] extends { response: z.ZodType } ? K : never;
}[keyof ApiRoutes];

type ResponseOf<K extends FetchRouteKey> = ApiRoutes[K] extends { response: infer R extends z.ZodType } ? z.output<R> : never;
type BodyOf<K extends FetchRouteKey> = ApiRoutes[K] extends { body: infer B extends z.ZodType } ? z.input<B> : undefined;
type HasId<K extends FetchRouteKey> = ApiRoutes[K]["path"] extends `${string}:id${string}` ? true : false;

type CallOptions<K extends FetchRouteKey> = { signal?: AbortSignal } & (BodyOf<K> extends undefined
  ? { body?: undefined }
  : { body: BodyOf<K> }) &
  (HasId<K> extends true ? { id: number } : { id?: undefined });

/** Ошибка вызова. network: сервер не ответил; unexpected: ответ не совпал с контрактом. */
export class ApiCallError extends Error {
  override name = "ApiCallError";
  constructor(
    readonly code: ApiErrorCode | "network" | "unexpected",
    message: string,
    readonly extra: { attemptsLeft?: number; retryAfterSeconds?: number; details?: string[] } = {},
  ) {
    super(message);
  }
}

const NETWORK_MESSAGE = "Нет связи с сервером. Проверьте подключение и повторите.";
const UNEXPECTED_MESSAGE = "Сервер ответил неожиданно. Обновите страницу и повторите.";

let csrfToken: string | null = null;
let sessionListener: ((reason: "expired" | "access_lost") => void) | null = null;

export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

/** Куда сообщать, что сессия закончилась или роль снята. */
export function onSessionLost(listener: (reason: "expired" | "access_lost") => void) {
  sessionListener = listener;
  return () => {
    sessionListener = null;
  };
}

async function send<K extends FetchRouteKey>(key: K, options: CallOptions<K>): Promise<ResponseOf<K>> {
  const route = apiRoutes[key] as { method: string; path: string; response: z.ZodType };
  const path = options.id === undefined ? route.path : route.path.replace(":id", String(options.id));
  const headers: Record<string, string> = {};
  if (route.method !== "GET" && csrfToken) headers[CSRF_HEADER] = csrfToken;
  // POST без тела уходит без Content-Type, иначе сервер ответит 400.
  if (options.body !== undefined) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(path, {
      method: route.method,
      credentials: "same-origin",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiCallError("network", NETWORK_MESSAGE);
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = apiError.safeParse(payload);
    if (!parsed.success) throw new ApiCallError("unexpected", UNEXPECTED_MESSAGE);
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new ApiCallError(parsed.data.error.code, parsed.data.error.message, {
      ...(parsed.data.error.attemptsLeft === undefined ? {} : { attemptsLeft: parsed.data.error.attemptsLeft }),
      ...(retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
      ...(parsed.data.error.details === undefined ? {} : { details: parsed.data.error.details }),
    });
  }
  const result = route.response.safeParse(payload);
  if (!result.success) throw new ApiCallError("unexpected", UNEXPECTED_MESSAGE);
  return result.data as ResponseOf<K>;
}

export async function fetchMe(signal?: AbortSignal): Promise<MeResponse> {
  const me = await send("me", signal ? { signal } : {});
  setCsrfToken(me.status === "teacher" ? me.csrfToken : null);
  return me;
}

export async function api<K extends FetchRouteKey>(key: K, options: CallOptions<K>): Promise<ResponseOf<K>> {
  try {
    return await send(key, options);
  } catch (error) {
    if (!(error instanceof ApiCallError)) throw error;
    if (error.code === "csrf_failed") {
      // Токен устарел: сервер запрос отклонил, ничего не изменилось. Берём новый и повторяем один раз.
      const me = await fetchMe();
      if (me.status === "teacher") return send(key, options);
      sessionListener?.(me.status === "no_access" ? "access_lost" : "expired");
    }
    if (error.code === "unauthorized") sessionListener?.("expired");
    if (error.code === "no_access") sessionListener?.("access_lost");
    throw error;
  }
}

/** «нет перевода» → «Нет перевода.» */
export function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return trimmed;
  const capital = trimmed[0]!.toUpperCase() + trimmed.slice(1);
  return /[.!?…]$/.test(capital) ? capital : `${capital}.`;
}

/** Текст ошибки для человека: сообщения сервера уже на русском. */
export function errorText(error: unknown): string {
  if (error instanceof ApiCallError) {
    if (error.code === "rate_limited" && error.extra.retryAfterSeconds) {
      return `Слишком много попыток. Повторите через ${error.extra.retryAfterSeconds} с.`;
    }
    const details = error.extra.details ?? [];
    return details.length > 0 ? [error.message, ...details.map(sentence)].join(" ") : error.message;
  }
  return UNEXPECTED_MESSAGE;
}

/** Подробности отказа: для invalid_card — понятные преподавателю ошибки карточки. */
export const errorDetails = (error: unknown): string[] =>
  error instanceof ApiCallError ? (error.extra.details ?? []) : [];

export const isApiError = (error: unknown, code: ApiErrorCode) => error instanceof ApiCallError && error.code === code;

export const isNotFound = (error: unknown) => error instanceof ApiCallError && error.code === "not_found";
