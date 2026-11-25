# Graph Report - english-bot-concept  (2026-11-24)

## Corpus Check
- 193 files · ~155,049 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1702 nodes · 5125 edges · 77 communities (75 shown, 2 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 33 edges (avg confidence: 0.83)
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
- unlink.test.ts
- Copy.tsx
- schema.ts
- db/fixtures.ts
- choice-options.ts
- learning/index.ts
- practice.test.ts
- CardForm.tsx
- План разработки Telegram-бота и веб-кабинета преподавателя
- Концепция Telegram-сервиса для изучения английского — MVP.md
- format.ts
- createCopyService
- fake-telegram.ts
- bot-preview.ts
- api-contract.ts
- Shell.tsx
- devDependencies
- word-state.ts
- scripts
- dependencies
- compilerOptions
- config.ts
- kit.tsx
- parse-table.ts
- compilerOptions
- bot/learning.ts
- Сценарий работы Telegram-бота для изучения английского
- server/index.ts
- views.ts
- bot/linking.ts
- translate.test.ts
- copies.ts
- linking/service.ts
- copies.test.ts
- client.ts
- tsconfig.build.json
- Актуальные схемы
- bot/index.ts
- collection-status.test.ts
- pilot-cycle.test.ts
- exam-progress-settings.test.ts
- package.json
- prepare-student.ts
- pg-local.sh
- App.tsx
- practice-render.ts
- createLinkingService
- registerApi
- purity.test.ts
- TablePaste.tsx
- createLearningService
- learningHandlers
- Request.tsx
- questionScreen
- secrets.ts
- results/csv.ts
- materials/issue.ts
- student-results.ts
- main.ts
- learning/practice.ts
- card.ts
- deploy
- session.test.ts
- db-constraints.test.ts
- Развёртывание на Railway и резервные копии
- dev-student-practice.ts
- db-backup.sh

## God Nodes (most connected - your core abstractions)
1. `api()` - 44 edges
2. `registerApi()` - 39 edges
3. `createFakeBot()` - 39 edges
4. `users` - 36 edges
5. `callbackUpdate()` - 32 edges
6. `learningHandlers()` - 31 edges
7. `openTestDb()` - 31 edges
8. `Db` - 30 edges
9. `resetDb()` - 28 edges
10. `studentLinks` - 26 edges

## Surprising Connections (you probably didn't know these)
- `answerCurrent()` --calls--> `answerButton()`  [EXTRACTED]
  test/helpers/learning.ts → src/bot/callback-data.ts
- `started()` --calls--> `startTest()`  [EXTRACTED]
  test/learning/buttons.test.ts → src/bot/callback-data.ts
- `startedTranslate()` --calls--> `startTranslate()`  [EXTRACTED]
  test/learning/translate.test.ts → src/bot/callback-data.ts
- `openHardList()` --calls--> `hardWordsPage()`  [EXTRACTED]
  test/learning/hard-words.test.ts → src/bot/callback-data.ts
- `createFakeBot()` --calls--> `createBot()`  [EXTRACTED]
  test/helpers/fake-telegram.ts → src/bot/index.ts

## Import Cycles
- None detected.

## Communities (77 total, 2 thin omitted)

### Community 0 - "learning-render.ts"
Cohesion: 0.09
Nodes (47): collectionCard(), hardWordsPage(), startHardSelected(), BUTTON_LABEL_LIMIT, clampPage(), clip(), CollectionCardItem, collectionCardScreen() (+39 more)

### Community 1 - "api/index.ts"
Cohesion: 0.08
Nodes (24): LinkingError, BodyOf, CODE_RATE, isMutation(), LOGIN_RATE, ResourceAccess, ResourceContext, ResourceResolver (+16 more)

### Community 2 - "helpers/learning.ts"
Cohesion: 0.14
Nodes (24): collectionPage(), collectionsPage(), startTest(), wordCard(), practice(), answer(), answerButtons(), Button (+16 more)

### Community 3 - "auth.test.ts"
Cohesion: 0.14
Nodes (13): webSessions, LOGIN_SCOPE, CSRF_COOKIE, LOGIN_COOKIE, SESSION_COOKIE, app(), { db, close }, logged() (+5 more)

### Community 4 - "learning/service.ts"
Cohesion: 0.08
Nodes (25): Answered, AnswerResult, buildResult(), CardContent, CollectionSessionType, collectionTitle(), DailyScreen, DailyStartResult (+17 more)

### Community 5 - "helpers.ts"
Cohesion: 0.09
Nodes (43): MAIN, AccountName, accounts, ADMIN_DATABASE_URL, baseUrl(), E2E_APP_SECRET, E2E_DATABASE_URL, E2E_DB_NAME (+35 more)

### Community 6 - "unlink.test.ts"
Cohesion: 0.08
Nodes (31): NEW_CODE, loadFixtureCollections(), adminAuditLog, attempts, cardViews, invitations, sessions, users (+23 more)

### Community 7 - "Copy.tsx"
Cohesion: 0.14
Nodes (28): CopyCard, CopyDetail, SourceCard, CardFields, fieldsFromCard(), cardsText(), pluralize(), studentsText() (+20 more)

### Community 8 - "schema.ts"
Cohesion: 0.11
Nodes (17): createdAt(), invitationStatus, notificationReason, notificationStatus, questionDirection, questionFormat, QuestionOption, questionStatus (+9 more)

### Community 9 - "db/fixtures.ts"
Cohesion: 0.14
Nodes (19): { db, close }, { db, close }, [rawLinkId, title], loadDatabaseConfig(), issueCollectionCopy(), BASIC_COLLECTION_TITLE, FixtureCard, fixtureCardSchema (+11 more)

### Community 10 - "choice-options.ts"
Cohesion: 0.15
Nodes (22): AnswerCheck, checkAnswer(), isBlankAnswer(), matchesCard(), buildChoiceOptions(), ChoiceOptions, ChoiceOptionsInput, AnswerCard (+14 more)

### Community 11 - "learning/index.ts"
Cohesion: 0.14
Nodes (33): buildExamPlan(), ExamCandidate, ExamOptions, selectExamWords(), toPlanWord(), buildQuestPlan(), QuestCandidate, QuestOptions (+25 more)

### Community 12 - "practice.test.ts"
Cohesion: 0.13
Nodes (26): prepareReminder(), addDays(), formatClock(), formatter(), formatters, isValidTimeZone(), localDate(), localMinutes() (+18 more)

### Community 13 - "CardForm.tsx"
Cohesion: 0.20
Nodes (19): errorDetails(), CardFieldName, DecodedFile, EMPTY_CARD, FieldErrors, fieldOfMessage(), findDuplicate(), groupErrors() (+11 more)

### Community 14 - "План разработки Telegram-бота и веб-кабинета преподавателя"
Cohesion: 0.06
Nodes (33): 10. Что понадобится от заказчика, 11. Риски и открытые вопросы, 1. Цель и текущее состояние, 2.1. Формат и пилот, 2.2. Роли и привязка, 2.3. Материалы и результаты, 2.4. Обучение, 2.5. Значения, выбранные разработчиком (+25 more)

### Community 15 - "Концепция Telegram-сервиса для изучения английского — MVP.md"
Cohesion: 0.06
Nodes (32): 10\. Подробная аналитика учеников, 1\. Карточки со словами, 2\. Режим изучения, 3\. Тестирование, 4\. Письменная практика, 5\. Прогресс ученика, 6\. Личный словарь ученика, 7\. Банк ошибок ученика (+24 more)

### Community 16 - "format.ts"
Cohesion: 0.11
Nodes (30): InvitationOutcome, IssueOutcome, PendingAction, StudentStatus, WordState, COLLECTION_STATUS_LABEL, DIRECTION_LABEL, formatDateTime() (+22 more)

### Community 17 - "createCopyService"
Cohesion: 0.43
Nodes (7): listCurrentCards(), createCopyService(), copyOfCard(), detail(), findCopy(), lockCopy(), ownCopy()

### Community 18 - "fake-telegram.ts"
Cohesion: 0.11
Nodes (24): createDb(), HEALTH_PATH, WEBHOOK_PATH, { db, close }, html, openTestDb(), resetDb(), TEST_DATABASE_URL (+16 more)

### Community 19 - "bot-preview.ts"
Cohesion: 0.12
Nodes (26): CardContent, BotScreen, BUTTON_LABEL_LIMIT, cardScreen(), clip(), collectionExtendedMessage(), contentLines(), correctFeedback() (+18 more)

### Community 20 - "api-contract.ts"
Cohesion: 0.06
Nodes (42): AddCopyCardsBody, AddCopyCardsResponse, answerList, ApiError, ApiErrorCode, apiErrorCodes, collectionStatus, collectionTitle (+34 more)

### Community 21 - "Shell.tsx"
Cohesion: 0.14
Nodes (16): Gate(), Screen(), LOGIN_ERROR_TEXT, consumeTitleFocus(), subscribe(), usePathname(), loginPaths, SessionState (+8 more)

### Community 22 - "devDependencies"
Cohesion: 0.08
Nodes (25): @axe-core/playwright, drizzle-kit, devDependencies, @axe-core/playwright, drizzle-kit, @playwright/test, tsx, @types/node (+17 more)

### Community 23 - "word-state.ts"
Cohesion: 0.16
Nodes (17): AppliedAnswer, applyAnswer(), ApplyAnswerResult, applyFirstAttemptCorrect(), INITIAL_WORD_STATE, mergeWordStates(), unchanged(), WordLearningState (+9 more)

### Community 24 - "scripts"
Cohesion: 0.08
Nodes (25): scripts, admin:remove-teacher, admin:set-teacher, build, build:web, db:backup, db:generate, db:local:psql (+17 more)

### Community 25 - "dependencies"
Cohesion: 0.09
Nodes (23): drizzle-orm, fastify, @fastify/cookie, @fastify/static, grammy, jose, dependencies, drizzle-orm (+15 more)

### Community 26 - "compilerOptions"
Cohesion: 0.10
Nodes (20): DOM, DOM.Iterable, ES2023, ../shared/api-contract.ts, ./**/*.ts, ./**/*.tsx, vite/client, compilerOptions (+12 more)

### Community 27 - "config.ts"
Cohesion: 0.14
Nodes (18): AppConfig, appEnvSchema, DatabaseConfig, databaseEnvSchema, loadConfig(), loadWebConfig(), parseEnv(), postgresUrl (+10 more)

### Community 28 - "kit.tsx"
Cohesion: 0.11
Nodes (26): InvitationResponse, IssuePreviewResponse, RenameStudentBody, StudentDetail, StudentListItem, ApiCallError, isNotFound(), ISSUE_OUTCOME_LABEL (+18 more)

### Community 29 - "parse-table.ts"
Cohesion: 0.11
Nodes (30): EmptyWordTextError, WordKey, CARD_LIMITS, HEADER_WORDS, IMPORT_COLUMNS, ImportColumn, ImportColumnKey, looksLike() (+22 more)

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
Cohesion: 0.18
Nodes (11): ApiFailure, errorBody(), MESSAGES, STATUS, ApiOptions, buildServer(), BuildServerOptions, fastify (+3 more)

### Community 34 - "views.ts"
Cohesion: 0.27
Nodes (16): expireStale(), personName(), getDashboard(), getRequest(), getStudentDetail(), lastActivity(), LinkWithStudent, listStudents() (+8 more)

### Community 35 - "bot/linking.ts"
Cohesion: 0.27
Nodes (15): DECLINE_JOIN, JOIN_PATTERN, joinButton(), SWITCH_PATTERN, switchButton(), codeText(), LINKING_TEXTS, linkingHandlers() (+7 more)

### Community 36 - "translate.test.ts"
Cohesion: 0.14
Nodes (25): createSeededRng(), { db, close }, NOW, createFakeBot(), newUpdateId(), card(), connectStudent(), issue() (+17 more)

### Community 37 - "copies.ts"
Cohesion: 0.09
Nodes (32): DbTx, makeWordKey(), sameWord(), acceptCard(), contentOf(), hasSameWord(), keyOf(), sameContent() (+24 more)

### Community 38 - "linking/service.ts"
Cohesion: 0.08
Nodes (30): [action, rawId], { db, close }, messages, telegramId, OPEN_STATUSES, RemoveTeacherResult, removeTeacherRole(), SetTeacherResult (+22 more)

### Community 39 - "copies.test.ts"
Cohesion: 0.10
Nodes (19): collectionFromNotification(), notifications, NotificationReason, notificationKeyboard(), renderNotification(), text(), claimDue(), deliverDueNotifications() (+11 more)

### Community 40 - "client.ts"
Cohesion: 0.16
Nodes (19): Db, DbHandle, DbOrTx, cardVersions, PracticeStudentInput, PracticeStudentResult, listVisibleCollections(), ownedVisibleLink() (+11 more)

### Community 41 - "tsconfig.build.json"
Cohesion: 0.14
Nodes (13): e2e, test, ./tsconfig.json, compilerOptions, noEmit, outDir, rootDir, exclude (+5 more)

### Community 42 - "Актуальные схемы"
Cohesion: 0.15
Nodes (12): Актуальные схемы, Архив: прежний сценарий, Вопрос и вторая попытка, Ежедневный квест, Общий цикл, Общий цикл, Привязка ученика, Путь преподавателя (+4 more)

### Community 43 - "bot/index.ts"
Cohesion: 0.29
Nodes (9): AppUser, BotContext, BOT_ERROR_TEXT, botErrorHandler(), createBot(), CreateBotOptions, describeBotError(), attachAppUser() (+1 more)

### Community 44 - "collection-status.test.ts"
Cohesion: 0.25
Nodes (6): CollectionCardProgress, CollectionStatus, answered, answeredBlind, fresh, viewed

### Community 45 - "pilot-cycle.test.ts"
Cohesion: 0.06
Nodes (61): startTranslate(), ApiRoutes, CollectionResults, CreateStudentResponse, CSRF_HEADER, DashboardResponse, ImportPreviewResponse, ImportResponse (+53 more)

### Community 46 - "exam-progress-settings.test.ts"
Cohesion: 0.12
Nodes (30): wordsPage(), questions, callbackUpdate(), lastButtons(), sentTexts(), answerCurrent(), currentStep(), FakeBot (+22 more)

### Community 47 - "package.json"
Cohesion: 0.33
Nodes (5): engines, node, name, private, type

### Community 48 - "prepare-student.ts"
Cohesion: 0.12
Nodes (17): args, { databaseUrl, web }, { db, close }, hardArg, remindNow, resetProgress, timezone, DEV_DEFAULT_TIMEZONE (+9 more)

### Community 49 - "pg-local.sh"
Cohesion: 0.67
Nodes (5): ensure_db(), find_bin(), is_running(), pg-local.sh script, start()

### Community 50 - "App.tsx"
Cohesion: 0.17
Nodes (18): App(), api(), useQuery(), ErrorBoundary, root, CollectionResultsScreen(), Collections(), CopyAdd() (+10 more)

### Community 51 - "practice-render.ts"
Cohesion: 0.14
Nodes (25): remindersToggle(), reminderTimeButton(), resumeSession(), timezoneButton(), timezoneList(), chooseTimezoneButton(), dailyScreen(), examScreen() (+17 more)

### Community 52 - "createLinkingService"
Cohesion: 0.17
Nodes (5): { databaseUrl, web }, { db, close }, [invite, rawId, name], telegramId, createLinkingService()

### Community 53 - "registerApi"
Cohesion: 0.17
Nodes (29): constantTimeEqual(), registerApi(), finishLogin(), parseBody(), parseId(), requireOwnLink(), requireTeacher(), resourceRoute() (+21 more)

### Community 59 - "TablePaste.tsx"
Cohesion: 0.19
Nodes (13): DEFAULT_MAX_ROWS, ImportResult, ImportRow, sentence(), looksBinary(), readCsvFile(), DELIMITER_LABEL, IMPORT_EXAMPLE (+5 more)

### Community 60 - "createLearningService"
Cohesion: 0.20
Nodes (13): practiceStudent(), contentOf(), createLearningService(), advance(), createQuestion(), createSession(), makeCurrent(), recordAttempt() (+5 more)

### Community 61 - "learningHandlers"
Cohesion: 0.29
Nodes (17): answerCallback(), learningHandlers(), menuScreen(), openCollection(), replyMenu(), sendProgress(), sendQuestion(), showDaily() (+9 more)

### Community 62 - "Request.tsx"
Cohesion: 0.21
Nodes (12): ApproveRequestBody, CollectionTitleBody, JoinRequest, errorText(), attemptsText(), RenameCollection(), CollectionNew(), TITLE_MAX (+4 more)

### Community 63 - "questionScreen"
Cohesion: 0.60
Nodes (5): answerButton(), pauseSession(), questionHeader(), questionScreen(), typedQuestionScreen()

### Community 64 - "secrets.ts"
Cohesion: 0.36
Nodes (6): createLinkingSecrets(), hmac(), INVITE_TOKEN_PATTERN, LinkingSecrets, otherSecrets, secrets

### Community 65 - "results/csv.ts"
Cohesion: 0.12
Nodes (20): RFC-5987, RFC-6266, COLLECTION_STATUS_LABEL, CSV_BOM, CSV_DELIMITER, csvCell(), csvContentDisposition(), csvDocument() (+12 more)

### Community 66 - "materials/issue.ts"
Cohesion: 0.15
Nodes (14): attachCardsToStudent(), upsertStudentWord(), sourceCards, sourceCollections, studentCards, studentCollections, computeCollectionStatus(), refreshCollectionStatuses() (+6 more)

### Community 67 - "student-results.ts"
Cohesion: 0.17
Nodes (18): AttemptRow, attemptsOfLinks(), emptyScore(), getCollectionResults(), getStudentResults(), groupByQuestion(), iso(), QuestionAnswers (+10 more)

### Community 68 - "main.ts"
Cohesion: 0.19
Nodes (13): ConfigError, createLogger(), CreateLoggerOptions, LOG_LEVELS, LogLevel, logLevelFromEnv(), REDACT_PATHS, ALLOWED_UPDATES (+5 more)

### Community 69 - "learning/practice.ts"
Cohesion: 0.23
Nodes (15): markHardWords(), createSessionState(), activeLinkId(), closeStaleQuests(), EnsuredQuest, ensureTodayQuest(), examCandidates(), findQuest() (+7 more)

### Community 70 - "card.ts"
Cohesion: 0.27
Nodes (13): NormalizeAnswerOptions, normalizeWordText(), CardInput, checkAccepted(), checkLength(), cleanAcceptedAnswers(), cleanLine(), cleanText() (+5 more)

### Community 71 - "deploy"
Cohesion: 0.15
Nodes (12): build, builder, dockerfilePath, deploy, healthcheckPath, healthcheckTimeout, preDeployCommand, restartPolicyMaxRetries (+4 more)

### Community 72 - "session.test.ts"
Cohesion: 0.24
Nodes (11): nextNewPosition(), nextStep(), recordAnswer(), summarizeSession(), AskedQuestion, afterChange(), pruneOpenSessions(), orderedPlan() (+3 more)

### Community 73 - "db-constraints.test.ts"
Cohesion: 0.31
Nodes (8): processedUpdates, studentWords, { db, close }, makeActiveLink(), makeQuestion(), makeRecord(), makeUser(), expectConstraintViolation()

### Community 74 - "Развёртывание на Railway и резервные копии"
Cohesion: 0.25
Nodes (7): 1. Что разворачивается, 2. Переменные окружения сервиса, 3. Первое размещение по шагам, 4. Журнал ошибок, 5. Резервные копии, 6. Ручная проверка после размещения, Развёртывание на Railway и резервные копии

### Community 75 - "dev-student-practice.ts"
Cohesion: 0.33
Nodes (5): args, { databaseUrl, web }, { db, close }, rawId, PracticeStudentError

## Knowledge Gaps
- **509 isolated node(s):** `MAIN`, `E2E_APP_SECRET`, `CreatedStudent`, `MAIN`, `TRAVEL` (+504 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `users` connect `unlink.test.ts` to `api/index.ts`, `helpers/learning.ts`, `auth.test.ts`, `learning/service.ts`, `schema.ts`, `db/fixtures.ts`, `fake-telegram.ts`, `views.ts`, `linking/service.ts`, `copies.test.ts`, `client.ts`, `bot/index.ts`, `pilot-cycle.test.ts`, `exam-progress-settings.test.ts`, `prepare-student.ts`, `createLinkingService`, `registerApi`, `materials/issue.ts`, `student-results.ts`, `db-constraints.test.ts`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **Why does `createLearningService()` connect `createLearningService` to `helpers/learning.ts`, `learning/service.ts`, `learning/practice.ts`, `unlink.test.ts`, `client.ts`, `bot/index.ts`, `practice.test.ts`, `learning/index.ts`, `exam-progress-settings.test.ts`?**
  _High betweenness centrality (0.012) - this node is a cross-community bridge._
- **Why does `Db` connect `client.ts` to `api/index.ts`, `helpers/learning.ts`, `learning/service.ts`, `helpers.ts`, `unlink.test.ts`, `db/fixtures.ts`, `fake-telegram.ts`, `server/index.ts`, `views.ts`, `copies.ts`, `linking/service.ts`, `copies.test.ts`, `bot/index.ts`, `pilot-cycle.test.ts`, `exam-progress-settings.test.ts`, `prepare-student.ts`, `registerApi`, `materials/issue.ts`, `student-results.ts`?**
  _High betweenness centrality (0.011) - this node is a cross-community bridge._
- **What connects `MAIN`, `E2E_APP_SECRET`, `CreatedStudent` to the rest of the system?**
  _509 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `learning-render.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.09219858156028368 - nodes in this community are weakly interconnected._
- **Should `api/index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.08275862068965517 - nodes in this community are weakly interconnected._
- **Should `helpers/learning.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.1408199643493761 - nodes in this community are weakly interconnected._