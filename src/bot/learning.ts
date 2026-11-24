// Учебные разделы бота: меню, словарь, подборки и тест. Решения принимает сервис, здесь только показ.
import { Composer, GrammyError, InlineKeyboard, type Context } from "grammy";
import type { LearningService, SessionProgress } from "../learning/service.js";
import {
  ANSWER_PATTERN,
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
  menuKeyboard,
  questionScreen,
  resultKeyboard,
  resultText,
  skippedText,
  soonKeyboard,
  staleScreen,
  wordCardScreen,
  wordsScreen,
  type Screen,
} from "./learning-render.js";
import { newCodeKeyboard, requestText } from "./linking.js";

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

async function sendProgress(ctx: Context, progress: SessionProgress, prefix?: string) {
  if (prefix) await ctx.reply(prefix);
  if (progress.skipped.length > 0) await ctx.reply(skippedText(progress.skipped));
  if (progress.kind === "finished") {
    await ctx.reply(resultText(progress.result), { reply_markup: resultKeyboard() });
    return;
  }
  const { text, keyboard } = questionScreen(progress.question);
  await ctx.reply(text, { reply_markup: keyboard });
}

export function learningHandlers(learning: LearningService): Composer<BotContext> {
  const composer = new Composer<BotContext>();
  // Учебные разделы работают только в личном чате.
  const direct = composer.chatType("private");

  /** Экран меню. Заявка к новому преподавателю ждёт рядом с материалами, полученными раньше. */
  async function menuScreen(ctx: BotContext): Promise<Screen> {
    const open = await learning.listOpenSessions(requireUser(ctx).id);
    const access = ctx.studentAccess;
    const lines: string[] = [];
    if (access?.kind === "former") lines.push(LEARNING_TEXTS.menuFormer, "");
    lines.push(LEARNING_TEXTS.menu);
    const keyboard = menuKeyboard(open);
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

  direct.callbackQuery(SOON_PATTERN, async (ctx) => {
    await answerCallback(ctx);
    await showInPlace(ctx, LEARNING_TEXTS.soon, soonKeyboard());
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

  direct.callbackQuery(START_TEST_PATTERN, async (ctx) => {
    const result = await learning.startCollectionTest({
      userId: requireUser(ctx).id,
      collectionId: Number(ctx.match[1]),
    });
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
  });

  direct.callbackQuery(RESUME_PATTERN, async (ctx) => {
    const result = await learning.resumeSession({ userId: requireUser(ctx).id, sessionId: Number(ctx.match[1]) });
    switch (result.kind) {
      case "not_found":
        await answerCallback(ctx, LEARNING_TEXTS.sessionNotFound);
        return;
      case "finished":
        await answerCallback(ctx);
        await showInPlace(ctx, resultText(result.result), resultKeyboard());
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
        await showInPlace(ctx, feedbackText(result.feedback, result.becameHard));
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

  // Текст относится только к открытому вопросу с вводом ответа, таких вопросов до этапа 5 нет: это не ответ.
  direct.on("message", async (ctx) => {
    const open = await learning.listOpenSessions(requireUser(ctx).id);
    await replyMenu(ctx, open.some((session) => session.status === "current") ? LEARNING_TEXTS.noOpenQuestionHint : undefined);
  });

  return composer;
}

