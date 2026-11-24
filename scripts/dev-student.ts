// Разработка кабинета без Telegram: изображает ученика, подтвердившего ссылку, и печатает код.
// npm run dev:student -- <ссылка или токен> <telegram_id> [имя]
import { eq } from "drizzle-orm";
import { loadWebConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { users } from "../src/db/schema.js";
import { createLinkingService } from "../src/linking/service.js";

const [invite, rawId, name] = process.argv.slice(2);
if (!invite || !rawId || !/^[1-9]\d{0,15}$/.test(rawId)) {
  console.error("Использование: npm run dev:student -- <ссылка или токен> <telegram_id> [имя]");
  process.exit(1);
}
const { databaseUrl, web } = loadWebConfig();
if (web.isProduction) {
  console.error("Команда не работает при NODE_ENV=production");
  process.exit(1);
}
const token = invite.includes("start=") ? new URL(invite).searchParams.get("start") ?? "" : invite;
const telegramId = Number(rawId);
const { db, close } = createDb(databaseUrl);
try {
  const profile = { telegramFirstName: name ?? `Ученик ${telegramId}`, telegramUsername: `student${telegramId}` };
  await db.insert(users).values({ telegramId, ...profile }).onConflictDoUpdate({ target: users.telegramId, set: profile });
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.telegramId, telegramId));
  const linking = createLinkingService(db, web.appSecret);
  const result = await linking.confirmJoin({ userId: user!.id, token, allowSwitch: true });
  if (result.kind === "joined") console.log(`Заявка создана. Код: ${result.code}`);
  else if (result.kind === "own_request") {
    const fresh = await linking.reissueCode({ userId: user!.id });
    console.log(fresh.kind === "issued" ? `Заявка уже была. Новый код: ${fresh.code}` : "Заявка не найдена");
  } else {
    console.log(`Отказ: ${result.kind}`);
    process.exitCode = 1;
  }
} finally {
  await close();
}
