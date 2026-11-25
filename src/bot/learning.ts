// Учебные разделы бота: меню, словарь, подборки, тест, «Переведи меня», сложные слова,
// ежедневная практика, экзамен, прогресс и настройки.
// Решения принимает сервис, здесь только показ.
import { Composer, GrammyError, InlineKeyboard, type Context } from "grammy";
import type { AskedQuestion, LearningService, SessionProgress } from "../learning/service.js";
import {
  ANSWER_PATTERN,
  DAILY_OPEN,
  DAILY_START,
  EXAM_OPEN,
  EXAM_START,
  PROGRESS_OPEN,
  REMINDERS_TOGGLE_PATTERN,
  REMINDER_TIME_LIST,
  REMINDER_TIME_PATTERN,
  SETTINGS_OPEN,
  TIMEZONE_LIST_PATTERN,
  TIMEZONE_PATTERN,
  HARD_WORDS_PAGE_PATTERN,
  START_HARD_ALL,
  START_HARD_SELECTED_PATTERN,
  START_TRANSLATE_PATTERN,
  COLLECTIONS_PAGE_PATTERN,
  COLLECTION_CARD_PATTERN,
  COLLECTION_NOTIFICATION_PATTERN,
  COLLECTION_PAGE_PATTERN,
  MENU,
  PAUSE_PATTERN,
  RESUME_PATTERN,
  SOON_PATTERN,
  START_TEST_PATTERN,
  WORDS_PAGE_PATTERN,
  WORD_CARD_PATTERN,
  resumeSession,
} from "./callback-data.js";
import type { AppUser, BotContext } from "./context.js";
import {
  LEARNING_TEXTS,
  collectionCardScreen,
  collectionScreen,
  collectionsScreen,
  feedbackText,
  hardWordsScreen,
  menuKeyboard,
  questionScreen,
  resultKeyboard,
  resultText,
  selectedHardWords,
  staleScreen,
  wordCardScreen,
  wordsScreen,
  type Screen,
} from "./learning-render.js";
import { newCodeKeyboard, requestText } from "./linking.js";
import {
  PRACTICE_TEXTS,
  chooseTimezoneButton,
  dailyScreen,
  examScreen,
  progressScreen,
  reminderTimeScreen,
  settingsScreen,
  timezoneScreen,
} from "./practice-render.js";

function requireUser(ctx: BotContext): AppUser {
  if (!ctx.appUser) throw new Error("Обработчик вызван для события без отправителя");
  return ctx.appUser;
}

/** Запрос нажатия мог устареть, например за время простоя сервиса. Занятию это не мешает. */
async function answerCallback(ctx: Context, text?: string) {
  try {
    await ctx.answerCallbackQuery(text ? { text } : {});
  } catch (error) {
    if (!(error instanceof GrammyError) || error.error_code !== 400) throw error;
  }
}

/**
 * Показывает экран в том же сообщении. Двойное нажатие даёт ошибку «не изменено»,
 * а старое сообщение может быть недоступно для правки: тогда экран уходит новым сообщением.
 */
async function showInPlace(ctx: Context, text: string, keyboard?: InlineKeyboard) {
  const markup = keyboard ? { reply_markup: keyboard } : {};
  try {
    await ctx.editMessageText(text, markup);
  } catch (error) {
    if (!(error instanceof GrammyError) || error.error_code !== 400) throw error;
    if (error.description.includes("message is not modified")) return;
    await ctx.reply(text, markup);
  }
}

const showScreen = (ctx: Context, screen: Screen) => showInPlace(ctx, screen.text, screen.keyboard);

export type LearningHandlersOptions = {
  /** Часы для показа смещения часовых поясов. В тестах подменяются. */
  now?: () => Date;
};

export function learningHandlers(learning: LearningService, options: LearningHandlersOptions = {}): Composer<BotContext> {
  const clock = options.now ?? (() => new Date());
  const composer = new Composer<BotContext>();
  // Учебные разделы работают только в личном чате.
  const direct = composer.chatType("private");

  /**
   * Вопрос всегда уходит новым сообщением. Для вопроса с вводом номер сообщения записывается:
   * текст, отправленный раньше показа, ответом не считается.
   */
  async function sendQuestion(ctx: BotContext, question: AskedQuestion) {
    const { text, keyboard } = questionScreen(question);
    const sent = await ctx.reply(text, { reply_markup: keyboard });
    if (question.format === "typed") {
      await learning.markQuestionShown({ userId: requireUser(ctx).id, questionId: question.questionId, messageId: sent.message_id });
    }
  }

  async function sendProgress(ctx: BotContext, progress: SessionProgress, prefix?: string) {
    if (prefix) await ctx.reply(prefix);
    if (progress.kind === "finished") {
      await ctx.reply(resultText(progress.result), { reply_markup: resultKeyboard(progress.result.type) });
      return;
    }
    await sendQuestion(ctx, progress.question);
  }

  /** Экран меню. Заявка к новому преподавателю ждёт рядом с материалами, полученными раньше. */
  async function menuScreen(ctx: BotContext): Promise<Screen> {
    const open = await learning.listOpenSessions(requireUser(ctx).id);
    const access = ctx.studentAccess;
    const lines: string[] = [];
    if (access?.kind === "former") lines.push(LEARNING_TEXTS.menuFormer, "");
    // Пока пояс не выбран, напоминаний нет: бот снова предлагает выбрать его при каждом входе (раздел 2.5 плана).
    const needsTimezone = requireUser(ctx).timezone === null;
    if (needsTimezone) lines.push(PRACTICE_TEXTS.timezoneMissing, "");
    lines.push(LEARNING_TEXTS.menu);
    const keyboard = menuKeyboard(open);
    if (needsTimezone) chooseTimezoneButton(keyboard.row());
    if (access?.kind === "former" && access.request) {
      lines.push("", requestText(access.request.codeActive));
      keyboard.row();
      newCodeKeyboard().inline_keyboard.flat().forEach((button) => keyboard.add(button));
    }
    return { text: lines.join("\n"), keyboard };
  }

  async function replyMenu(ctx: BotContext, prefix?: string) {
    const { text, keyboard } = await menuScreen(ctx);
    await ctx.reply(prefix ? `${prefix}\n\n${text}` : text, { reply_markup: keyboard });
  }

  direct.command(["start", "menu"], (ctx) => replyMenu(ctx));
  direct.command("help", (ctx) => replyMenu(ctx, LEARNING_TEXTS.help));

  direct.callbackQuery(MENU, async (ctx) => {
    await answerCallback(ctx);
    await showScreen(ctx, await menuScreen(ctx));
  });

  // ---------- Ежедневная практика, экзамен, прогресс ----------

  async function showDaily(ctx: BotContext) {
    await answerCallback(ctx);
    await showScreen(ctx, dailyScreen(await learning.openDaily(requireUser(ctx).id)));
  }

  async function showExam(ctx: BotContext) {
    await answerCallback(ctx);
    await showScreen(ctx, examScreen(await learning.openExam(requireUser(ctx).id)));
  }

  async function showProgress(ctx: BotContext) {
    await answerCallback(ctx);
    await showScreen(ctx, progressScreen(await learning.getProgress(requireUser(ctx).id)));
  }

  direct.callbackQuery(DAILY_OPEN, showDaily);
  direct.callbackQuery(EXAM_OPEN, showExam);
  direct.callbackQuery(PROGRESS_OPEN, showProgress);

  // «Начать» в разделе и в напоминании. Квест приходит новым сообщением: напоминание остаётся в чате.
  direct.callbackQuery(DAILY_START, async (ctx) => {
    const result = await learning.startDaily(requireUser(ctx).id);
    switch (result.kind) {
      case "no_timezone":
      case "no_words":
        await showDaily(ctx);
        return;
      case "finished":
        await answerCallback(ctx, PRACTICE_TEXTS.dailyCompleted);
        await ctx.reply(resultText(result.result), { reply_markup: resultKeyboard(result.result.type) });
        return;
      case "started":
        await answerCallback(ctx);
        await sendProgress(ctx, result.progress, result.pausedPrevious ? LEARNING_TEXTS.pausedPrevious : undefined);
        return;
    }
  });

  direct.callbackQuery(EXAM_START, async (ctx) => {
    const result = await learning.startExam(requireUser(ctx).id);
    switch (result.kind) {
      case "not_found":
      case "no_words":
        await showExam(ctx);
        return;
      case "started":
        await answerCallback(ctx);
        await sendProgress(ctx, result.progress, result.pausedPrevious ? LEARNING_TEXTS.pausedPrevious : undefined);
        return;
    }
  });

  // ---------- Настройки ----------

  const userSettings = (ctx: BotContext) => learning.getSettings(requireUser(ctx).id);

  direct.callbackQuery(SETTINGS_OPEN, async (ctx) => {
    await answerCallback(ctx);
    await showScreen(ctx, settingsScreen(await userSettings(ctx), clock()));
  });

  direct.callbackQuery(REMINDERS_TOGGLE_PATTERN, async (ctx) => {
    const enabled = ctx.match[1] === "1";
    const settings = await learning.setRemindersEnabled(requireUser(ctx).id, enabled);
    await answerCallback(ctx, enabled ? PRACTICE_TEXTS.remindersOn : PRACTICE_TEXTS.remindersOff);
    await showScreen(ctx, settingsScreen(settings, clock()));
  });

  direct.callbackQuery(REMINDER_TIME_LIST, async (ctx) => {
    await answerCallback(ctx);
    await showScreen(ctx, reminderTimeScreen(await userSettings(ctx)));
  });

  direct.callbackQuery(REMINDER_TIME_PATTERN, async (ctx) => {
    const settings = await learning.setReminderTime(requireUser(ctx).id, Number(ctx.match[1]));
    if (!settings) {
      await answerCallback(ctx, LEARNING_TEXTS.obsoleteButton);
      return;
    }
    await answerCallback(ctx, PRACTICE_TEXTS.timeSaved);
    await showScreen(ctx, settingsScreen(settings, clock(), PRACTICE_TEXTS.timeSaved));
  });

  direct.callbackQuery(TIMEZONE_LIST_PATTERN, async (ctx) => {
    await answerCallback(ctx);
    await showScreen(ctx, timezoneScreen(await userSettings(ctx), Number(ctx.match[1]), clock()));
  });

  direct.callbackQuery(TIMEZONE_PATTERN, async (ctx) => {
    const settings = await learning.setTimezone(requireUser(ctx).id, ctx.match[1] as string);
    if (!settings) {
      await answerCallback(ctx, PRACTICE_TEXTS.invalidTimezone);
      return;
    }
    await answerCallback(ctx, PRACTICE_TEXTS.timezoneSaved);
    await showScreen(ctx, settingsScreen(settings, clock(), PRACTICE_TEXTS.timezoneSaved));
  });

  // Кнопки «появится позже» из сообщений до этапа 6 ведут в настоящие разделы.
  direct.callbackQuery(SOON_PATTERN, async (ctx) => {
    switch (ctx.match[1]) {
      case "daily":
        return showDaily(ctx);
      case "exam":
        return showExam(ctx);
      case "progress":
        return showProgress(ctx);
      default:
        await answerCallback(ctx);
        await showScreen(ctx, settingsScreen(await userSettings(ctx), clock()));
    }
  });

  // ---------- Все слова ----------

  direct.callbackQuery(WORDS_PAGE_PATTERN, async (ctx) => {
    const words = await learning.listWords(requireUser(ctx).id);
    await answerCallback(ctx);
    await showScreen(ctx, wordsScreen(words, Number(ctx.match[1])));
  });

  direct.callbackQuery(WORD_CARD_PATTERN, async (ctx) => {
    const page = Number(ctx.match[2]);
    const word = await learning.openWord({ userId: requireUser(ctx).id, studentWordId: Number(ctx.match[1]) });
    if (!word) {
      await answerCallback(ctx, LEARNING_TEXTS.cardNotFound);
      return;
    }
    await answerCallback(ctx);
    await showScreen(ctx, wordCardScreen(word, page));
  });

  // ---------- Подборки ----------

  async function openCollection(ctx: BotContext, collectionId: number, page: number): Promise<Screen | null> {
    const user = requireUser(ctx);
    const screen = await learning.openCollection({ userId: user.id, collectionId });
    if (!screen) return null;
    const rendered = collectionScreen(screen, page, user.timezone);
    await learning.markCardsShown({ userId: user.id, cardIds: rendered.shownCardIds });
    return rendered;
  }

  direct.callbackQuery(COLLECTIONS_PAGE_PATTERN, async (ctx) => {
    const user = requireUser(ctx);
    const collections = await learning.listCollections(user.id);
    await answerCallback(ctx);
    await showScreen(ctx, collectionsScreen(collections, Number(ctx.match[1]), user.timezone));
  });

  direct.callbackQuery(COLLECTION_PAGE_PATTERN, async (ctx) => {
    const screen = await openCollection(ctx, Number(ctx.match[1]), Number(ctx.match[2]));
    if (!screen) {
      await answerCallback(ctx, LEARNING_TEXTS.collectionNotFound);
      return;
    }
    await answerCallback(ctx);
    await showScreen(ctx, screen);
  });

  direct.callbackQuery(COLLECTION_NOTIFICATION_PATTERN, async (ctx) => {
    const screen = await openCollection(ctx, Number(ctx.match[1]), 0);
    if (!screen) {
      await answerCallback(ctx, LEARNING_TEXTS.collectionNotFound);
      return;
    }
    await answerCallback(ctx);
    await ctx.reply(screen.text, { reply_markup: screen.keyboard });
  });

  direct.callbackQuery(COLLECTION_CARD_PATTERN, async (ctx) => {
    const page = Number(ctx.match[2]);
    const screen = await learning.openCollectionCard({ userId: requireUser(ctx).id, cardId: Number(ctx.match[1]) });
    if (!screen) {
      await answerCallback(ctx, LEARNING_TEXTS.cardNotFound);
      return;
    }
    await answerCallback(ctx);
    await showScreen(ctx, collectionCardScreen(screen, page));
  });

  // ---------- Тест ----------

  async function startCollectionSession(ctx: BotContext, collectionId: number, type: "test" | "translate") {
    const result = await learning.startCollectionSession({ userId: requireUser(ctx).id, collectionId, type });
    switch (result.kind) {
      case "not_found":
        await answerCallback(ctx, LEARNING_TEXTS.collectionNotFound);
        return;
      case "no_words":
        await answerCallback(ctx, LEARNING_TEXTS.emptyCollection);
        return;
      case "started":
        await answerCallback(ctx);
        await sendProgress(ctx, result.progress, result.pausedPrevious ? LEARNING_TEXTS.pausedPrevious : undefined);
        return;
    }
  }

  direct.callbackQuery(START_TEST_PATTERN, (ctx) => startCollectionSession(ctx, Number(ctx.match[1]), "test"));
  direct.callbackQuery(START_TRANSLATE_PATTERN, (ctx) => startCollectionSession(ctx, Number(ctx.match[1]), "translate"));

  // ---------- Сложные слова ----------

  direct.callbackQuery(HARD_WORDS_PAGE_PATTERN, async (ctx) => {
    const screen = await learning.openHardWords(requireUser(ctx).id);
    await answerCallback(ctx);
    await showScreen(ctx, hardWordsScreen(screen, Number(ctx.match[1]), Number(ctx.match[2])));
  });

  async function startHardPractice(ctx: BotContext, wordIds: readonly number[] | "all") {
    const userId = requireUser(ctx).id;
    const result = wordIds === "all" || wordIds.length > 0 ? await learning.startHardPractice({ userId, wordIds }) : null;
    if (result?.kind !== "started") {
      // Список изменился с момента показа: выбранных слов на странице уже нет или они освоены.
      await answerCallback(ctx, LEARNING_TEXTS.hardWordsChanged);
      await showScreen(ctx, hardWordsScreen(await learning.openHardWords(userId), 0, 0));
      return;
    }
    await answerCallback(ctx);
    await sendProgress(ctx, result.progress, result.pausedPrevious ? LEARNING_TEXTS.pausedPrevious : undefined);
  }

  direct.callbackQuery(START_HARD_ALL, (ctx) => startHardPractice(ctx, "all"));

  direct.callbackQuery(START_HARD_SELECTED_PATTERN, async (ctx) => {
    const { words } = await learning.openHardWords(requireUser(ctx).id);
    const selected = selectedHardWords(words, Number(ctx.match[1]), Number(ctx.match[2]));
    await startHardPractice(ctx, selected.map((word) => word.studentWordId));
  });

  direct.callbackQuery(RESUME_PATTERN, async (ctx) => {
    const result = await learning.resumeSession({ userId: requireUser(ctx).id, sessionId: Number(ctx.match[1]) });
    switch (result.kind) {
      case "not_found":
        await answerCallback(ctx, LEARNING_TEXTS.sessionNotFound);
        return;
      case "finished":
        await answerCallback(ctx);
        await showInPlace(ctx, resultText(result.result), resultKeyboard(result.result.type));
        return;
      case "resumed":
        await answerCallback(ctx);
        await sendProgress(ctx, result.progress, result.pausedPrevious ? LEARNING_TEXTS.pausedPrevious : undefined);
        return;
    }
  });

  direct.callbackQuery(PAUSE_PATTERN, async (ctx) => {
    const sessionId = Number(ctx.match[1]);
    const result = await learning.pauseSession({ userId: requireUser(ctx).id, sessionId });
    if (result.kind === "not_found") {
      await answerCallback(ctx, LEARNING_TEXTS.sessionNotFound);
      return;
    }
    await answerCallback(ctx);
    if (result.kind === "paused") {
      await showInPlace(
        ctx,
        LEARNING_TEXTS.paused,
        new InlineKeyboard().text("Продолжить", resumeSession(sessionId)).row().text("В меню", MENU),
      );
    }
  });

  direct.callbackQuery(ANSWER_PATTERN, async (ctx) => {
    const result = await learning.answerChoice({
      userId: requireUser(ctx).id,
      questionId: Number(ctx.match[1]),
      attemptNumber: Number(ctx.match[2]),
      optionIndex: Number(ctx.match[3]),
    });
    switch (result.kind) {
      case "not_found":
      case "invalid_option":
        await answerCallback(ctx, LEARNING_TEXTS.staleCallback);
        return;
      case "stale": {
        const screen = staleScreen(result);
        await answerCallback(ctx, screen.callback);
        await showScreen(ctx, screen);
        return;
      }
      case "answered":
        await answerCallback(ctx);
        await showInPlace(ctx, feedbackText(result.feedback, result));
        await sendProgress(ctx, result.next);
        return;
    }
  });

  // ---------- Всё остальное ----------

  // Кнопка из старого сообщения, например демо-упражнения этапа 1.
  direct.on("callback_query:data", async (ctx) => {
    await answerCallback(ctx, LEARNING_TEXTS.obsoleteButton);
    await replyMenu(ctx);
  });

  // Текст — ответ, только если у текущего занятия открыт вопрос с вводом и сообщение отправлено после его показа.
  // Команда ответом не бывает: известные команды обработаны выше, остальные ведут в меню.
  direct.on("message:text", async (ctx, next) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return next();
    const result = await learning.answerTyped({ userId: requireUser(ctx).id, text, messageId: ctx.message.message_id });
    switch (result.kind) {
      case "no_question":
        await replyMenu(ctx);
        return;
      case "choice_question":
        await replyMenu(ctx, LEARNING_TEXTS.noOpenQuestionHint);
        return;
      case "early":
        await ctx.reply(LEARNING_TEXTS.earlyAnswer);
        await sendQuestion(ctx, result.question);
        return;
      case "blank":
        await ctx.reply(LEARNING_TEXTS.blankAnswer);
        return;
      case "answered":
        await ctx.reply(feedbackText(result.feedback, result));
        await sendProgress(ctx, result.next);
        return;
    }
  });

  // Остальные сообщения (фото, стикеры, неизвестные команды) ответом не считаются.
  direct.on("message", async (ctx) => {
    const open = await learning.listOpenSessions(requireUser(ctx).id);
    await replyMenu(ctx, open.some((session) => session.status === "current") ? LEARNING_TEXTS.noOpenQuestionHint : undefined);
  });

  return composer;
}

