# Graph Report - english-bot-concept  (2026-11-24)

## Corpus Check
- 176 files · ~139,185 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1536 nodes · 4590 edges · 67 communities (64 shown, 3 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 29 edges (avg confidence: 0.83)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `90b139e1`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- learning-render.ts
- api/index.ts
- helpers/learning.ts
- auth.test.ts
- learning/service.ts
- helpers.ts
- students.test.ts
- Collection.tsx
- schema.ts
- prepare-student.ts
- choice-options.ts
- learning/index.ts
- notifications/reminders.ts
- CardForm.tsx
- План разработки Telegram-бота и веб-кабинета преподавателя
- Концепция Telegram-сервиса для изучения английского — MVP.md
- kit.tsx
- createCopyService
- session.tsx
- bot-preview.ts
- api-contract.ts
- App.tsx
- devDependencies
- word-state.ts
- scripts
- dependencies
- compilerOptions
- config.ts
- format.ts
- source.ts
- compilerOptions
- bot/learning.ts
- Сценарий работы Telegram-бота для изучения английского
- server/index.ts
- service.test.ts
- bot/linking.ts
- createIssueService
- registerApi
- copies.ts
- notifications.test.ts
- .send
- tsconfig.build.json
- Актуальные схемы
- bot/index.ts
- collection-status.test.ts
- copies.test.ts
- client.ts
- package.json
- dev-prepare-student.ts
- pg-local.sh
- main.tsx
- practice-render.ts
- createLinkingService
- api/session.ts
- purity.test.ts
- lib/api.ts
- createLearningService
- learningHandlers
- Copy.tsx
- bot-preview.test.ts
- secrets.ts
- api/errors.ts
- RateLimiter

## God Nodes (most connected - your core abstractions)
1. `api()` - 40 edges
2. `registerApi()` - 34 edges
3. `createFakeBot()` - 34 edges
4. `users` - 32 edges
5. `learningHandlers()` - 31 edges
6. `callbackUpdate()` - 28 edges
7. `Db` - 27 edges
8. `openTestDb()` - 26 edges
9. `studentLinks` - 24 edges
10. `resetDb()` - 23 edges

## Surprising Connections (you probably didn't know these)
- `visibleWords()` --calls--> `listVisibleCards()`  [EXTRACTED]
  test/materials/copies.test.ts → src/learning/vocabulary.ts
- `enqueue()` --calls--> `enqueueNotification()`  [EXTRACTED]
  test/notifications.test.ts → src/notifications/queue.ts
- `answerCurrent()` --calls--> `answerButton()`  [EXTRACTED]
  test/helpers/learning.ts → src/bot/callback-data.ts
- `allWordPages()` --calls--> `wordsPage()`  [EXTRACTED]
  test/learning/materials.test.ts → src/bot/callback-data.ts
- `startThroughMenu()` --calls--> `collectionsPage()`  [EXTRACTED]
  test/helpers/learning.ts → src/bot/callback-data.ts

## Import Cycles
- None detected.

## Communities (67 total, 3 thin omitted)

### Community 0 - "learning-render.ts"
Cohesion: 0.12
Nodes (42): collectionCard(), collectionPage(), collectionsPage(), hardWordsPage(), startHardSelected(), startTranslate(), wordCard(), wordsPage() (+34 more)

### Community 1 - "api/index.ts"
Cohesion: 0.11
Nodes (21): BodyOf, CODE_RATE, LOGIN_RATE, ResourceAccess, ResourceContext, ResourceResolver, RouteSpec, StudentContext (+13 more)

### Community 2 - "helpers/learning.ts"
Cohesion: 0.08
Nodes (68): startTest(), attempts, cardViews, questions, sessions, studentWords, practice(), ApiCall (+60 more)

### Community 3 - "auth.test.ts"
Cohesion: 0.15
Nodes (18): CSRF_HEADER, app(), { db, close }, logged(), started(), twoTeachers(), BOT_ID, Browser (+10 more)

### Community 4 - "learning/service.ts"
Cohesion: 0.06
Nodes (55): markHardWords(), questStreak(), activeLinkId(), closeStaleQuests(), completedQuestDates(), EnsuredQuest, ensureTodayQuest(), examCandidates() (+47 more)

### Community 5 - "helpers.ts"
Cohesion: 0.09
Nodes (39): MAIN, AccountName, accounts, ADMIN_DATABASE_URL, baseUrl(), E2E_APP_SECRET, E2E_DATABASE_URL, E2E_DB_NAME (+31 more)

### Community 6 - "students.test.ts"
Cohesion: 0.08
Nodes (25): adminAuditLog, invitations, webSessions, { db, close }, linking, accessOf(), card, contractOf() (+17 more)

### Community 7 - "Collection.tsx"
Cohesion: 0.20
Nodes (20): api(), isNotFound(), cardsText(), studentsText(), QueryState, CardsTable(), CollectionQueryError(), CollectionScreen() (+12 more)

### Community 8 - "schema.ts"
Cohesion: 0.09
Nodes (25): cardVersions, createdAt(), invitationStatus, notificationReason, notificationStatus, processedUpdates, questionDirection, questionFormat (+17 more)

### Community 9 - "prepare-student.ts"
Cohesion: 0.08
Nodes (42): { db, close }, { db, close }, [rawLinkId, title], attachCardsToStudent(), issueCollectionCopy(), listCurrentCards(), upsertStudentWord(), BASIC_COLLECTION_TITLE (+34 more)

### Community 10 - "choice-options.ts"
Cohesion: 0.15
Nodes (23): AnswerCheck, checkAnswer(), isBlankAnswer(), matchesCard(), buildChoiceOptions(), ChoiceOptions, ChoiceOptionsInput, AnswerCard (+15 more)

### Community 11 - "learning/index.ts"
Cohesion: 0.12
Nodes (39): buildExamPlan(), ExamCandidate, ExamOptions, selectExamWords(), toPlanWord(), buildQuestPlan(), QuestOptions, QuestSettings (+31 more)

### Community 12 - "notifications/reminders.ts"
Cohesion: 0.14
Nodes (28): prepareReminder(), addDays(), formatClock(), formatter(), formatters, isValidTimeZone(), localDate(), localMinutes() (+20 more)

### Community 13 - "CardForm.tsx"
Cohesion: 0.14
Nodes (27): SourceCard, errorDetails(), CardFieldName, CardFields, DecodedFile, EMPTY_CARD, FieldErrors, fieldOfMessage() (+19 more)

### Community 14 - "План разработки Telegram-бота и веб-кабинета преподавателя"
Cohesion: 0.06
Nodes (33): 10. Что понадобится от заказчика, 11. Риски и открытые вопросы, 1. Цель и текущее состояние, 2.1. Формат и пилот, 2.2. Роли и привязка, 2.3. Материалы и результаты, 2.4. Обучение, 2.5. Значения, выбранные разработчиком (+25 more)

### Community 15 - "Концепция Telegram-сервиса для изучения английского — MVP.md"
Cohesion: 0.06
Nodes (32): 10\. Подробная аналитика учеников, 1\. Карточки со словами, 2\. Режим изучения, 3\. Тестирование, 4\. Письменная практика, 5\. Прогресс ученика, 6\. Личный словарь ученика, 7\. Банк ошибок ученика (+24 more)

### Community 16 - "kit.tsx"
Cohesion: 0.25
Nodes (6): consumeTitleFocus(), CheckboxFieldProps, PageTitle(), STATUS_TONE, TextAreaFieldProps, TextFieldProps

### Community 17 - "createCopyService"
Cohesion: 0.53
Nodes (6): createCopyService(), copyOfCard(), detail(), findCopy(), lockCopy(), ownCopy()

### Community 18 - "session.tsx"
Cohesion: 0.16
Nodes (14): ApiRoutes, LoginErrorCode, loginErrorCodes, MeResponse, fetchMe(), onSessionLost(), setCsrfToken(), AnonymousMe (+6 more)

### Community 19 - "bot-preview.ts"
Cohesion: 0.15
Nodes (20): createSeededRng(), BotScreen, BUTTON_LABEL_LIMIT, cardScreen(), clip(), contentLines(), correctFeedback(), DIRECTION_HINT (+12 more)

### Community 20 - "api-contract.ts"
Cohesion: 0.06
Nodes (35): AddCopyCardsBody, answerList, ApiError, ApiErrorCode, apiErrorCodes, ApproveRequestBody, CardContent, collectionTitle (+27 more)

### Community 21 - "App.tsx"
Cohesion: 0.16
Nodes (25): Gate(), Screen(), errorText(), attemptsText(), Link(), navigate(), subscribe(), usePathname() (+17 more)

### Community 22 - "devDependencies"
Cohesion: 0.08
Nodes (25): @axe-core/playwright, drizzle-kit, devDependencies, @axe-core/playwright, drizzle-kit, @playwright/test, tsx, @types/node (+17 more)

### Community 23 - "word-state.ts"
Cohesion: 0.15
Nodes (18): AppliedAnswer, applyAnswer(), ApplyAnswerResult, applyFirstAttemptCorrect(), INITIAL_WORD_STATE, mergeWordStates(), unchanged(), WordLearningState (+10 more)

### Community 24 - "scripts"
Cohesion: 0.09
Nodes (22): scripts, admin:remove-teacher, admin:set-teacher, build, build:web, db:generate, db:local:psql, db:local:start (+14 more)

### Community 25 - "dependencies"
Cohesion: 0.10
Nodes (21): drizzle-orm, fastify, @fastify/cookie, @fastify/static, grammy, jose, dependencies, drizzle-orm (+13 more)

### Community 26 - "compilerOptions"
Cohesion: 0.10
Nodes (20): DOM, DOM.Iterable, ES2023, ../shared/api-contract.ts, ./**/*.ts, ./**/*.tsx, vite/client, compilerOptions (+12 more)

### Community 27 - "config.ts"
Cohesion: 0.11
Nodes (23): [action, rawId], { db, close }, messages, telegramId, AppConfig, appEnvSchema, ConfigError, DatabaseConfig (+15 more)

### Community 28 - "format.ts"
Cohesion: 0.10
Nodes (30): InvitationResponse, StudentDetail, StudentListItem, StudentStatus, ApiCallError, COLLECTION_STATUS_LABEL, formatDateTime(), ISSUE_OUTCOME_LABEL (+22 more)

### Community 29 - "source.ts"
Cohesion: 0.05
Nodes (68): RFC-4180, NormalizeAnswerOptions, normalizeWordText(), EmptyWordTextError, WordKey, acceptCard(), contentOf(), hasSameWord() (+60 more)

### Community 30 - "compilerOptions"
Cohesion: 0.11
Nodes (18): *.config.ts, e2e/**/*.ts, node, test/**/*.ts, compilerOptions, module, moduleResolution, noEmit (+10 more)

### Community 31 - "bot/learning.ts"
Cohesion: 0.12
Nodes (29): ANSWER_PATTERN, COLLECTION_CARD_PATTERN, COLLECTION_NOTIFICATION_PATTERN, COLLECTION_PAGE_PATTERN, COLLECTIONS_PAGE_PATTERN, DAILY_OPEN, DAILY_START, EXAM_OPEN (+21 more)

### Community 32 - "Сценарий работы Telegram-бота для изучения английского"
Cohesion: 0.11
Nodes (18): 10. Экзамен, 11. Сценарий преподавателя, 12. Правила хранения и диалога, 13. Что ещё остаётся решить, 1. Формат и основной цикл, 2. Меню ученика и словарь, 3. Подключение ученика, 4. Занятие: общие правила (+10 more)

### Community 33 - "server/index.ts"
Cohesion: 0.16
Nodes (15): ALLOWED_UPDATES, main(), startReminderScheduler(), ApiOptions, createTelegramLogin(), buildServer(), BuildServerOptions, fastify (+7 more)

### Community 34 - "service.test.ts"
Cohesion: 0.16
Nodes (17): expireStale(), LinkingError, MAX_CODE_ATTEMPTS, personName(), getDashboard(), getStudentDetail(), lastActivity(), LinkWithStudent (+9 more)

### Community 35 - "bot/linking.ts"
Cohesion: 0.19
Nodes (19): DECLINE_JOIN, JOIN_PATTERN, joinButton(), NEW_CODE, SWITCH_PATTERN, switchButton(), AppUser, codeText() (+11 more)

### Community 37 - "registerApi"
Cohesion: 0.28
Nodes (13): getRequest(), createSourceService(), isMutation(), registerApi(), detailOrNotFound(), parseBody(), parseId(), requireOwnLink() (+5 more)

### Community 38 - "copies.ts"
Cohesion: 0.08
Nodes (42): OPEN_STATUSES, RemoveTeacherResult, removeTeacherRole(), SetTeacherResult, setTeacherRole(), Db, DbOrTx, DbTx (+34 more)

### Community 39 - "notifications.test.ts"
Cohesion: 0.17
Nodes (15): collectionFromNotification(), NotificationReason, notificationKeyboard(), renderNotification(), text(), claimDue(), deliverDueNotifications(), DeliveryOptions (+7 more)

### Community 40 - ".send"
Cohesion: 0.70
Nodes (4): connect(), createStudent(), materialsOf(), studentPath()

### Community 41 - "tsconfig.build.json"
Cohesion: 0.14
Nodes (13): e2e, test, ./tsconfig.json, compilerOptions, noEmit, outDir, rootDir, exclude (+5 more)

### Community 42 - "Актуальные схемы"
Cohesion: 0.15
Nodes (12): Актуальные схемы, Архив: прежний сценарий, Вопрос и вторая попытка, Ежедневный квест, Общий цикл, Общий цикл, Привязка ученика, Путь преподавателя (+4 more)

### Community 43 - "bot/index.ts"
Cohesion: 0.47
Nodes (5): BotContext, createBot(), CreateBotOptions, attachAppUser(), skipProcessedUpdates()

### Community 44 - "collection-status.test.ts"
Cohesion: 0.25
Nodes (7): CollectionCardProgress, CollectionStatus, computeCollectionStatus(), answered, answeredBlind, fresh, viewed

### Community 45 - "copies.test.ts"
Cohesion: 0.15
Nodes (23): AddCopyCardsResponse, CopyDetail, IssueResponse, at(), cardInput(), connectedStudent(), createCollection(), createStudent() (+15 more)

### Community 46 - "client.ts"
Cohesion: 0.13
Nodes (20): createDb(), DbHandle, openTestDb(), resetDb(), TEST_DATABASE_URL, answerCurrent(), currentStep(), clock() (+12 more)

### Community 47 - "package.json"
Cohesion: 0.33
Nodes (5): engines, node, name, private, type

### Community 48 - "dev-prepare-student.ts"
Cohesion: 0.25
Nodes (7): args, { databaseUrl, web }, { db, close }, hardArg, remindNow, resetProgress, timezone

### Community 49 - "pg-local.sh"
Cohesion: 0.67
Nodes (5): ensure_db(), find_bin(), is_running(), pg-local.sh script, start()

### Community 50 - "main.tsx"
Cohesion: 0.33
Nodes (3): App(), ErrorBoundary, root

### Community 51 - "practice-render.ts"
Cohesion: 0.14
Nodes (25): remindersToggle(), reminderTimeButton(), resumeSession(), timezoneButton(), timezoneList(), chooseTimezoneButton(), dailyScreen(), examScreen() (+17 more)

### Community 52 - "createLinkingService"
Cohesion: 0.17
Nodes (5): { databaseUrl, web }, { db, close }, [invite, rawId, name], telegramId, createLinkingService()

### Community 53 - "api/session.ts"
Cohesion: 0.17
Nodes (22): constantTimeEqual(), finishLogin(), ActiveSession, clearSessionCookies(), cookieFlags(), CookieOptions, createSession(), CSRF_COOKIE (+14 more)

### Community 59 - "lib/api.ts"
Cohesion: 0.13
Nodes (17): BodyOf, CallOptions, FetchRouteKey, HasId, ResponseOf, send(), sentence(), looksBinary() (+9 more)

### Community 60 - "createLearningService"
Cohesion: 0.15
Nodes (17): refreshCollectionStatuses(), contentOf(), createLearningService(), advance(), createQuestion(), createSession(), expireStaleQuest(), makeCurrent() (+9 more)

### Community 61 - "learningHandlers"
Cohesion: 0.29
Nodes (17): answerCallback(), learningHandlers(), menuScreen(), openCollection(), replyMenu(), sendProgress(), sendQuestion(), showDaily() (+9 more)

### Community 62 - "Copy.tsx"
Cohesion: 0.20
Nodes (9): collectionExtendedMessage(), CardExtras(), AddNotice(), CopyCards(), CopyHeader(), CopyQueryError(), CopyScreen(), ConfirmDialog() (+1 more)

### Community 63 - "bot-preview.test.ts"
Cohesion: 0.24
Nodes (10): answerButton(), pauseSession(), questionHeader(), questionScreen(), typedQuestionScreen(), newCollectionMessage(), card, expectSame() (+2 more)

### Community 64 - "secrets.ts"
Cohesion: 0.36
Nodes (6): createLinkingSecrets(), hmac(), INVITE_TOKEN_PATTERN, LinkingSecrets, otherSecrets, secrets

### Community 65 - "api/errors.ts"
Cohesion: 0.33
Nodes (4): ApiFailure, errorBody(), MESSAGES, STATUS

## Knowledge Gaps
- **445 isolated node(s):** `MAIN`, `E2E_APP_SECRET`, `CreatedStudent`, `MAIN`, `TRAVEL` (+440 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `users` connect `prepare-student.ts` to `api/index.ts`, `service.test.ts`, `auth.test.ts`, `learning/service.ts`, `helpers/learning.ts`, `copies.ts`, `notifications.test.ts`, `schema.ts`, `students.test.ts`, `bot/index.ts`, `notifications/reminders.ts`, `copies.test.ts`, `client.ts`, `createLinkingService`, `api/session.ts`?**
  _High betweenness centrality (0.018) - this node is a cross-community bridge._
- **Why does `registerApi()` connect `registerApi` to `api/index.ts`, `service.test.ts`, `api/errors.ts`, `createIssueService`, `RateLimiter`, `server/index.ts`, `createCopyService`, `createLinkingService`, `api/session.ts`?**
  _High betweenness centrality (0.018) - this node is a cross-community bridge._
- **Why does `makeWordKey()` connect `prepare-student.ts` to `helpers/learning.ts`, `copies.ts`, `choice-options.ts`, `CardForm.tsx`, `source.ts`?**
  _High betweenness centrality (0.015) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `learningHandlers()` (e.g. with `showDaily()` and `showExam()`) actually correct?**
  _`learningHandlers()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `MAIN`, `E2E_APP_SECRET`, `CreatedStudent` to the rest of the system?**
  _445 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `learning-render.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.12181616832779624 - nodes in this community are weakly interconnected._
- **Should `api/index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.11067193675889328 - nodes in this community are weakly interconnected._