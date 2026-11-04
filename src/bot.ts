import { Bot, InlineKeyboard } from "grammy";

const token = process.env.BOT_TOKEN;

if (!token) {
  throw new Error("Добавьте токен от BotFather в файл .env: BOT_TOKEN=...");
}

const bot = new Bot(token);

const word = {
  english: "breakfast",
  translation: "завтрак",
  example: "I have breakfast at eight. — Я завтракаю в восемь.",
  choices: ["Завтрак", "Обед", "Ужин"],
  correctChoice: 0,
};

const startKeyboard = new InlineKeyboard().text("Начать упражнение", "lesson:start");

bot.command("start", async (ctx) => {
  await ctx.reply(
    "Привет! Я помогу тебе практиковать английский каждый день. Начнём с одного слова?",
    { reply_markup: startKeyboard }
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply("Нажми /start, чтобы пройти первое упражнение.");
});

bot.callbackQuery("lesson:start", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `📚 ${word.english} — ${word.translation}\n\n${word.example}`,
    { reply_markup: new InlineKeyboard().text("Проверить себя", "lesson:quiz") }
  );
});

bot.callbackQuery("lesson:quiz", async (ctx) => {
  await ctx.answerCallbackQuery();

  const keyboard = new InlineKeyboard();
  word.choices.forEach((choice, index) => {
    keyboard.text(choice, `lesson:answer:${index}`).row();
  });

  await ctx.reply(`Как переводится слово ${word.english}?`, {
    reply_markup: keyboard,
  });
});

bot.callbackQuery(/^lesson:answer:(\d)$/, async (ctx) => {
  await ctx.answerCallbackQuery();

  const choice = Number(ctx.match[1]);
  const result =
    choice === word.correctChoice
      ? "✅ Верно! Breakfast — завтрак."
      : "❌ Пока нет. Breakfast — завтрак. Попробуй ещё раз.";

  await ctx.editMessageText(result, {
    reply_markup: new InlineKeyboard().text("Повторить", "lesson:start"),
  });
});

bot.catch((error) => {
  console.error("Ошибка при обработке сообщения:", error.error);
});

bot.start({
  onStart: ({ username }) => {
    console.log(`Бот @${username} запущен. Откройте его в Telegram и нажмите Start.`);
  },
});
