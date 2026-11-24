// Токены ссылок и коды хранятся только как HMAC с серверным секретом. У кода всего миллион
// значений: без секрета утечка базы раскрыла бы его перебором, поэтому простой хэш не подходит.
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type LinkingSecrets = ReturnType<typeof createLinkingSecrets>;

function hmac(secret: string, purpose: string, value: string): string {
  return createHmac("sha256", secret).update(purpose).update("\0").update(value).digest("base64url");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createLinkingSecrets(appSecret: string) {
  return {
    /** 32 случайных байта: 43 символа [A-Za-z0-9_-], в лимите Telegram на параметр Start (64). */
    generateInviteToken: () => randomBytes(32).toString("base64url"),
    hashInviteToken: (token: string) => hmac(appSecret, "invite-token", token),
    generateCode: () => String(randomInt(0, 1_000_000)).padStart(6, "0"),
    /** Хэш привязан к заявке: код от одной заявки не подходит к другой. */
    hashCode: (invitationId: number, code: string) => hmac(appSecret, "join-code", `${invitationId}:${code}`),
    verifyCode(invitationId: number, code: string, storedHash: string) {
      return constantTimeEqual(hmac(appSecret, "join-code", `${invitationId}:${code}`), storedHash);
    },
  };
}
