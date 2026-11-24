// npm run admin:set-teacher -- <telegram_id>
// npm run admin:remove-teacher -- <telegram_id>
import { userInfo } from "node:os";
import { removeTeacherRole, setTeacherRole } from "../src/admin/roles.js";
import { loadDatabaseConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";

const [action, rawId] = process.argv.slice(2);
if ((action !== "set-teacher" && action !== "remove-teacher") || !rawId || !/^[1-9]\d{0,15}$/.test(rawId)) {
  console.error("Использование: npm run admin:set-teacher -- <telegram_id> или npm run admin:remove-teacher -- <telegram_id>");
  process.exit(1);
}

const telegramId = Number(rawId);
const actor = `cli:${userInfo().username}`;
const { db, close } = createDb(loadDatabaseConfig().databaseUrl);
const messages: Record<string, string> = {
  granted: `Telegram ID ${telegramId}: роль преподавателя выдана, запись в журнале сделана.`,
  already_teacher: `Telegram ID ${telegramId} уже преподаватель, ничего не изменено.`,
  student_has_open_link: `Отказ: у Telegram ID ${telegramId} есть активная связь или незавершённая заявка ученика.`,
  removed: `Telegram ID ${telegramId}: роль преподавателя снята, сессии кабинета закрыты, запись в журнале сделана.`,
  not_teacher: `Telegram ID ${telegramId} не преподаватель, ничего не изменено.`,
  teacher_has_open_links: `Отказ: у преподавателя ${telegramId} есть подключённые ученики или заявки. Сначала он должен их завершить.`,
};
try {
  const result =
    action === "set-teacher"
      ? await setTeacherRole(db, { telegramId, actor })
      : await removeTeacherRole(db, { telegramId, actor });
  console.log(messages[result.kind]);
  if (result.kind === "student_has_open_link" || result.kind === "teacher_has_open_links") process.exitCode = 1;
} finally {
  await close();
}
