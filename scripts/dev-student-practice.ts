// Разработка кабинета без Telegram: ученик проходит тест по каждой своей подборке, чтобы появились результаты.
// npm run dev:student-practice -- <telegram_id> [--wrong=apple,cat]
// Слова из --wrong ученик дважды отвечает неверно — они станут сложными. Остальные — верно.
import { loadWebConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { PracticeStudentError, practiceStudent } from "../src/dev/practice-student.js";

const args = process.argv.slice(2);
const rawId = args.find((arg) => !arg.startsWith("--"));
const wrong = args.find((arg) => arg.startsWith("--wrong="))?.slice("--wrong=".length).split(",").filter(Boolean) ?? [];
if (!rawId || !/^[1-9]\d{0,15}$/.test(rawId)) {
  console.error("Использование: npm run dev:student-practice -- <telegram_id> [--wrong=слово1,слово2]");
  process.exit(1);
}
const { databaseUrl, web } = loadWebConfig();
if (web.isProduction) {
  console.error("Команда не работает при NODE_ENV=production");
  process.exit(1);
}
const { db, close } = createDb(databaseUrl);
try {
  const result = await practiceStudent(db, { studentTelegramId: Number(rawId), wrong });
  if (result.sessions.length === 0) console.log("Подборок с новыми вопросами нет: занятий не было.");
  for (const session of result.sessions) {
    const hard = session.becameHard.length > 0 ? `, стали сложными: ${session.becameHard.join(", ")}` : "";
    console.log(`Тест «${session.title}»: ответов ${session.answered}, верно с первой попытки ${session.firstAttemptCorrect}${hard}`);
  }
} catch (error) {
  console.error(error instanceof PracticeStudentError ? error.message : error);
  process.exitCode = 1;
} finally {
  await close();
}
