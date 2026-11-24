import { describe, expect, it } from "vitest";
import { INVITE_TOKEN_PATTERN, createLinkingSecrets } from "../../src/linking/secrets.js";

const secrets = createLinkingSecrets("a".repeat(32));
const otherSecrets = createLinkingSecrets("b".repeat(32));

describe("хэши ссылок и кодов", () => {
  it("токен случайный и укладывается в лимит Start", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => secrets.generateInviteToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      expect(token.length).toBeLessThanOrEqual(64);
      expect(token).toMatch(INVITE_TOKEN_PATTERN);
    }
  });

  it("код: ровно 6 цифр", () => {
    for (let i = 0; i < 500; i += 1) expect(secrets.generateCode()).toMatch(/^\d{6}$/);
  });

  it("хэш зависит от секрета: без него код нельзя подобрать по базе", () => {
    expect(secrets.hashCode(1, "123456")).not.toBe(otherSecrets.hashCode(1, "123456"));
    expect(secrets.hashInviteToken("t")).not.toBe(otherSecrets.hashInviteToken("t"));
  });

  it("хэш кода привязан к заявке и отделён от хэша токена", () => {
    expect(secrets.hashCode(1, "123456")).not.toBe(secrets.hashCode(2, "123456"));
    expect(secrets.verifyCode(1, "123456", secrets.hashCode(1, "123456"))).toBe(true);
    expect(secrets.verifyCode(2, "123456", secrets.hashCode(1, "123456"))).toBe(false);
    expect(secrets.verifyCode(1, "654321", secrets.hashCode(1, "123456"))).toBe(false);
    expect(secrets.verifyCode(1, "123456", "короткий")).toBe(false);
  });
});
