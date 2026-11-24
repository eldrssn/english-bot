// Вход через Telegram: OpenID Connect, Authorization Code с PKCE (https://core.telegram.org/bots/telegram-login).
// Вход только подтверждает Telegram ID; роль проверяет сервер и выдаёт её только администратор.
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";

export const TELEGRAM_ISSUER = "https://oauth.telegram.org";
const AUTH_ENDPOINT = `${TELEGRAM_ISSUER}/auth`;
const TOKEN_ENDPOINT = `${TELEGRAM_ISSUER}/token`;
const JWKS_ENDPOINT = `${TELEGRAM_ISSUER}/.well-known/jwks.json`;
export const LOGIN_SCOPE = "openid profile telegram:bot_access";
// EdDSA и ES256K в Telegram несовместимы со scope profile, поэтому не принимаются.
const ALLOWED_ALGORITHMS = ["RS256", "ES256"];
const TOKEN_TIMEOUT_MS = 10_000;

export type TelegramLogin = {
  clientId: string;
  clientSecret: string;
  /** Ожидаемый aud: ID бота. */
  botId: string;
  redirectUri: string;
  getKey: JWTVerifyGetKey;
  fetchFn: typeof fetch;
};

export function createTelegramLogin(input: {
  clientId: string;
  clientSecret: string;
  botId: string;
  redirectUri: string;
}): TelegramLogin {
  return { ...input, getKey: createRemoteJWKSet(new URL(JWKS_ENDPOINT)), fetchFn: fetch };
}

export type LoginParams = { state: string; nonce: string; codeVerifier: string };

export function newLoginParams(): LoginParams {
  const random = () => randomBytes(32).toString("base64url");
  return { state: random(), nonce: random(), codeVerifier: random() };
}

export function buildAuthorizationUrl(login: TelegramLogin, params: LoginParams): string {
  const url = new URL(AUTH_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: login.clientId,
    redirect_uri: login.redirectUri,
    response_type: "code",
    scope: LOGIN_SCOPE,
    state: params.state,
    nonce: params.nonce,
    code_challenge: createHash("sha256").update(params.codeVerifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

const tokenResponse = z.object({ id_token: z.string().min(1) });

const identityClaims = z.object({
  id: z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d{0,15}$/).transform(Number)]),
  nonce: z.string(),
  name: z.string().optional(),
  given_name: z.string().optional(),
  family_name: z.string().optional(),
  preferred_username: z.string().optional(),
});

export type TelegramIdentity = {
  telegramId: number;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
};

/** Проверяет подпись по JWKS, iss, aud, exp и nonce. Любое несоответствие — исключение. */
export async function verifyIdToken(login: TelegramLogin, idToken: string, nonce: string): Promise<TelegramIdentity> {
  const { payload } = await jwtVerify(idToken, login.getKey, {
    issuer: TELEGRAM_ISSUER,
    audience: login.botId,
    algorithms: ALLOWED_ALGORITHMS,
    requiredClaims: ["exp"],
  });
  const claims = identityClaims.parse(payload);
  if (claims.nonce !== nonce) throw new Error("nonce в id_token не совпал");
  return {
    telegramId: claims.id,
    firstName: claims.given_name ?? claims.name ?? null,
    lastName: claims.family_name ?? null,
    username: claims.preferred_username ?? null,
  };
}

export async function exchangeCode(login: TelegramLogin, code: string, codeVerifier: string): Promise<string> {
  const response = await login.fetchFn(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${login.clientId}:${login.clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: login.redirectUri,
      client_id: login.clientId,
      code_verifier: codeVerifier,
    }).toString(),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Токен Telegram не получен: ${response.status}`);
  return tokenResponse.parse(await response.json()).id_token;
}
