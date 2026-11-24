import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { Db } from "../../src/db/client.js";
import type { ApiOptions } from "../../src/server/api/index.js";
import { TELEGRAM_ISSUER, type TelegramLogin } from "../../src/server/api/login.js";
import { buildServer, type BuildServerOptions } from "../../src/server/index.js";
import { CSRF_HEADER, apiRoutes } from "../../src/shared/api-contract.js";
import { TEST_APP_SECRET } from "./fake-telegram.js";

export const BOT_ID = "123456";
export const CLIENT_ID = "client-id";
export const CLIENT_SECRET = "client-secret";
export const REDIRECT_URI = "https://cabinet.example/api/auth/telegram/callback";

type Claims = Record<string, unknown>;
export type TokenTweak = (token: SignJWT) => SignJWT;

/** Подмена Telegram: локальный JWKS и конечная точка токена, проверяющая Basic и PKCE. */
export async function createFakeOidc() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const foreign = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "local", alg: "ES256", use: "sig" };
  const getKey = createLocalJWKSet({ keys: [jwk] });

  const state = {
    /** Следующий ответ конечной точки токена. */
    nextIdToken: null as string | null,
    tokenStatus: 200,
    lastRequest: null as { authorization: string | null; form: URLSearchParams } | null,
    expectedChallenge: null as string | null,
  };

  const sign = (claims: Claims, options: { key?: CryptoKey; tweak?: TokenTweak; noExpiry?: boolean } = {}) => {
    let token = new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: "local" })
      .setIssuer(TELEGRAM_ISSUER)
      .setAudience(BOT_ID)
      .setIssuedAt();
    if (!options.noExpiry) token = token.setExpirationTime("1h");
    if (options.tweak) token = options.tweak(token);
    return token.sign(options.key ?? privateKey);
  };

  const fetchFn: typeof fetch = async (_url, init) => {
    const headers = new Headers(init?.headers);
    const form = new URLSearchParams(String(init?.body));
    state.lastRequest = { authorization: headers.get("authorization"), form };
    if (state.tokenStatus !== 200) return new Response("{}", { status: state.tokenStatus });
    const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
    if (challenge !== state.expectedChallenge) return new Response('{"error":"invalid_grant"}', { status: 400 });
    return new Response(JSON.stringify({ access_token: "a", token_type: "Bearer", expires_in: 3600, id_token: state.nextIdToken }));
  };

  const login: TelegramLogin = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, botId: BOT_ID, redirectUri: REDIRECT_URI, getKey, fetchFn };
  return { login, state, sign, foreignKey: foreign.privateKey };
}

export type FakeOidc = Awaited<ReturnType<typeof createFakeOidc>>;

export function buildTestApp(db: Db, oidc: FakeOidc | null, api: Partial<ApiOptions> = {}, server: Partial<BuildServerOptions> = {}) {
  return buildServer({
    db,
    api: {
      appSecret: TEST_APP_SECRET,
      isProduction: false,
      botUsername: "test_bot",
      login: oidc?.login ?? null,
      devLoginTelegramId: null,
      ...api,
    },
    ...server,
  });
}

/** Браузер: хранит cookie между запросами, как настоящий. */
export class Browser {
  readonly cookies = new Map<string, string>();
  csrfToken: string | null = null;

  constructor(private readonly app: FastifyInstance) {}

  async request(options: {
    method: string;
    url: string;
    payload?: unknown;
    headers?: Record<string, string>;
    remoteAddress?: string;
  }) {
    const response = await this.app.inject({
      method: options.method as "GET",
      url: options.url,
      ...(options.remoteAddress ? { remoteAddress: options.remoteAddress } : {}),
      headers: { ...options.headers },
      cookies: Object.fromEntries(this.cookies),
      ...(options.payload === undefined ? {} : { payload: options.payload as object }),
    });
    for (const cookie of response.cookies as { name: string; value: string; maxAge?: number; expires?: Date }[]) {
      const removed = cookie.value === "" || cookie.maxAge === 0 || (cookie.expires && cookie.expires.getTime() <= Date.now());
      if (removed) this.cookies.delete(cookie.name);
      else this.cookies.set(cookie.name, cookie.value);
    }
    return response;
  }

  get = (url: string) => this.request({ method: "GET", url });

  /** Изменяющий запрос с CSRF-токеном этой сессии. */
  send(method: string, url: string, payload?: unknown) {
    return this.request({
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
      headers: this.csrfToken ? { [CSRF_HEADER]: this.csrfToken } : {},
    });
  }

  async refreshCsrf() {
    const me = (await this.get(apiRoutes.me.path)).json();
    this.csrfToken = me.csrfToken ?? null;
    return me;
  }
}

/** Проходит вход до адреса возврата. Возвращает ответ на него. */
export async function loginWith(
  browser: Browser,
  oidc: FakeOidc,
  buildToken: (nonce: string) => Promise<string>,
) {
  const start = await browser.get(apiRoutes.telegramLoginStart.path);
  const auth = new URL(start.headers.location as string);
  const stateParam = auth.searchParams.get("state")!;
  oidc.state.expectedChallenge = auth.searchParams.get("code_challenge");
  oidc.state.nextIdToken = await buildToken(auth.searchParams.get("nonce")!);
  return browser.get(`${apiRoutes.telegramLoginCallback.path}?code=abc&state=${stateParam}`);
}

/** Настоящий путь входа с верным токеном. Для преподавателя также получает CSRF-токен. */
export async function loginAs(browser: Browser, oidc: FakeOidc, telegramId: number) {
  await loginWith(browser, oidc, (nonce) => oidc.sign({ id: telegramId, nonce, name: "Имя" }));
  await browser.refreshCsrf();
  return browser;
}
