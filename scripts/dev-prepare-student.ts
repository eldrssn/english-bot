// Готовит ученика к проверке бота: связь с преподавателем для разработки, три тестовые подборки
// как собственные подборки этого преподавателя (их видно и можно править в кабинете) и их выдача ученику.
// npm run dev:prepare-student -- [telegram_id] [--reset] [--hard[=N]] [--tz=<пояс>] [--remind]
//   telegram_id  ваш Telegram ID; без него берётся DEV_STUDENT_TELEGRAM_ID
//   --reset      начать обучение заново: удалить занятия (в том числе квесты и экзамены), ответы и просмотры
//   --hard[=N]   отметить N слов сложными (по умолчанию 3); у первого серия 4 из 5 — один верный ответ его освоит
//   --tz=<пояс>  часовой пояс IANA, например --tz=Asia/Yekaterinburg (иначе его выбирают в боте в «Настройках»)
//   --remind     напоминание о ежедневной практике прямо сейчас: время = текущая минута по поясу ученика
//                (без пояса — Europe/Moscow); запущенный сервис в течение минуты создаст квест и пришлёт напоминание
import { loadWebConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { loadFixtureCollections } from "../src/db/fixtures.js";
import { PrepareStudentError, prepareDevStudent } from "../src/dev/prepare-student.js";
import { IssueError } from "../src/learning/issue.js";
import { MaterialsError } from "../src/materials/errors.js";

const args = process.argv.slice(2);
const resetProgress = args.includes("--reset");
const hardArg = args.find((arg) => arg === "--hard" || arg.startsWith("--hard="));
const hardWords = hardArg === undefined ? 0 : hardArg === "--hard" ? 3 : Number(hardArg.slice("--hard=".length));
const timezone = args.find((arg) => arg.startsWith("--tz="))?.slice("--tz=".length);
const remindNow = args.includes("--remind");
const rawId = args.find((arg) => !arg.startsWith("--")) ?? process.env.DEV_STUDENT_TELEGRAM_ID;
const usage = "Использование: npm run dev:prepare-student -- <ваш telegram_id> [--reset] [--hard[=N]] [--tz=<пояс>] [--remind]";

if (!Number.isInteger(hardWords) || hardWords < 0 || hardWords > 50) {
  console.error("--hard=N: N — целое число от 0 до 50");
  process.exit(1);
}

if (!rawId || !/^[1-9]\d{0,15}$/.test(rawId)) {
  console.error(usage);
  console.error("Telegram ID можно не указывать, если задать DEV_STUDENT_TELEGRAM_ID в .env.local.");
  process.exit(1);
}
const { databaseUrl, web } = loadWebConfig();
if (web.isProduction) {
  console.error("Команда не работает при NODE_ENV=production");
  process.exit(1);
}
if (!web.devLoginTelegramId) {
  console.error("Нужен DEV_LOGIN_TELEGRAM_ID в .env.local: под этим преподавателем вы входите в кабинет.");
  process.exit(1);
}

const { db, close } = createDb(databaseUrl);
try {
  const result = await prepareDevStudent(db, {
    appSecret: web.appSecret,
    teacherTelegramId: web.devLoginTelegramId,
    studentTelegramId: Number(rawId),
    fixtures: await loadFixtureCollections(),
    resetProgress,
    hardWords,
    ...(timezone !== undefined ? { timezone } : {}),
    remindNow,
  });
  console.log(
    result.link === "created"
      ? `Связь создана: запись ученика ${result.linkId}, преподаватель ${result.teacherTelegramId}.`
      : `Связь уже была: запись ученика ${result.linkId}, преподаватель ${result.teacherTelegramId}.`,
  );
  for (const collection of result.teacherCollections) {
    console.log(`Подборка преподавателя ${collection.created ? "создана" : "уже была"}: ${collection.title} (${collection.id})`);
  }
  for (const collection of result.collections) {
    const from = collection.source === "seed" ? " (копия служебной тестовой подборки, а не подборки из кабинета)" : "";
    console.log(`  ${collection.created ? "выдана" : "уже была"}: ${collection.title}${from}`);
  }
  if (result.resetSessions !== null) {
    console.log(`Прогресс сброшен: удалено занятий ${result.resetSessions}, слова и подборки в начальном состоянии.`);
  }
  for (const word of result.hardWords) {
    console.log(`Сложное слово: ${word.english} — ${word.translation}, серия ${word.correctStreak} из 5`);
  }
  console.log(`Часовой пояс: ${result.timezone ?? "не выбран (бот предложит выбрать его в меню)"}`);
  if (result.reminder) {
    console.log(
      `Напоминание: время ${result.reminder.reminderTime}, локальная дата ${result.reminder.localDate}. ` +
        "Запущенный сервис (npm run dev) в течение минуты создаст квест и пришлёт напоминание.",
    );
    if (result.reminder.questCompletedToday) {
      console.log("Сегодняшний квест уже пройден, поэтому напоминания не будет. Добавьте --reset, чтобы пройти его заново.");
    }
  }
  console.log("Уведомления придут, когда запущен сервис (npm run dev). Если нет, откройте бота и нажмите /start.");
} catch (error) {
  if (error instanceof PrepareStudentError || error instanceof IssueError || error instanceof MaterialsError) {
    console.error(`Отказ: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await close();
}
