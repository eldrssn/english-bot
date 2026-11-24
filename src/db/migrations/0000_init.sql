CREATE TYPE "public"."invitation_status" AS ENUM('pending', 'awaiting_teacher', 'approved', 'rejected', 'revoked', 'withdrawn', 'expired');--> statement-breakpoint
CREATE TYPE "public"."notification_reason" AS ENUM('join_request', 'request_withdrawn', 'link_confirmed', 'link_ended', 'new_collection', 'collection_extended', 'daily_reminder');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('pending', 'sent', 'failed', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."question_direction" AS ENUM('ru_en', 'en_ru');--> statement-breakpoint
CREATE TYPE "public"."question_format" AS ENUM('choice', 'typed');--> statement-breakpoint
CREATE TYPE "public"."question_status" AS ENUM('open', 'awaiting_repeat', 'closed');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('current', 'paused', 'completed', 'incomplete');--> statement-breakpoint
CREATE TYPE "public"."session_type" AS ENUM('demo', 'test', 'translate', 'hard_words', 'daily_quest', 'exam');--> statement-breakpoint
CREATE TYPE "public"."student_collection_status" AS ENUM('assigned', 'started', 'practicing', 'completed');--> statement-breakpoint
CREATE TYPE "public"."student_link_status" AS ENUM('pending_connection', 'pending_confirmation', 'active', 'ended');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('teacher', 'student');--> statement-breakpoint
CREATE TYPE "public"."word_status" AS ENUM('learning', 'hard', 'mastered');--> statement-breakpoint
CREATE TABLE "admin_audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "admin_audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor" text NOT NULL,
	"target_user_id" bigint NOT NULL,
	"old_role" "user_role",
	"new_role" "user_role",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attempts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"question_id" bigint NOT NULL,
	"attempt_number" integer NOT NULL,
	"student_link_id" bigint,
	"selected_option_index" integer,
	"answer_text" text NOT NULL,
	"is_correct" boolean NOT NULL,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attempts_question_attempt_unique" UNIQUE("question_id","attempt_number"),
	CONSTRAINT "attempts_number_range" CHECK ("attempts"."attempt_number" IN (1, 2))
);
--> statement-breakpoint
CREATE TABLE "card_versions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "card_versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"student_card_id" bigint NOT NULL,
	"version_number" integer NOT NULL,
	"english" text NOT NULL,
	"primary_translation" text NOT NULL,
	"accepted_ru_en" text[] DEFAULT '{}'::text[] NOT NULL,
	"accepted_en_ru" text[] DEFAULT '{}'::text[] NOT NULL,
	"example" text,
	"explanation" text,
	"allow_omit_to" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_versions_card_number_unique" UNIQUE("student_card_id","version_number"),
	CONSTRAINT "card_versions_number_positive" CHECK ("card_versions"."version_number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "card_views" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "card_views_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"student_card_id" bigint NOT NULL,
	"card_version_id" bigint NOT NULL,
	"student_link_id" bigint,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "invitations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"student_link_id" bigint NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "invitation_status" DEFAULT 'pending' NOT NULL,
	"opened_by_telegram_id" bigint,
	"student_user_id" bigint,
	"requested_at" timestamp with time zone,
	"request_expires_at" timestamp with time zone,
	"code_hash" text,
	"code_expires_at" timestamp with time zone,
	"code_attempts" integer DEFAULT 0 NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invitations_code_attempts_non_negative" CHECK ("invitations"."code_attempts" >= 0),
	CONSTRAINT "invitations_request_has_student" CHECK ("invitations"."status" <> 'awaiting_teacher' OR "invitations"."student_user_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notifications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"recipient_user_id" bigint NOT NULL,
	"reason" "notification_reason" NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "notification_status" DEFAULT 'pending' NOT NULL,
	"delivery_attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "processed_updates" (
	"update_id" bigint PRIMARY KEY NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "questions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"session_id" bigint NOT NULL,
	"position" integer NOT NULL,
	"student_word_id" bigint NOT NULL,
	"card_version_id" bigint NOT NULL,
	"direction" "question_direction" NOT NULL,
	"format" "question_format" NOT NULL,
	"options" jsonb,
	"correct_option_index" integer,
	"status" "question_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "questions_session_position_unique" UNIQUE("session_id","position"),
	CONSTRAINT "questions_choice_has_options" CHECK (("questions"."format" = 'choice') = ("questions"."options" IS NOT NULL AND "questions"."correct_option_index" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sessions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"student_user_id" bigint NOT NULL,
	"student_link_id" bigint,
	"type" "session_type" NOT NULL,
	"status" "session_status" DEFAULT 'current' NOT NULL,
	"student_collection_id" bigint,
	"quest_local_date" date,
	"question_plan" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_quest_date_only_for_quest" CHECK (("sessions"."type" = 'daily_quest') = ("sessions"."quest_local_date" IS NOT NULL)),
	CONSTRAINT "sessions_step_non_negative" CHECK ("sessions"."current_step" >= 0)
);
--> statement-breakpoint
CREATE TABLE "source_cards" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "source_cards_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"collection_id" bigint NOT NULL,
	"position" integer NOT NULL,
	"english" text NOT NULL,
	"primary_translation" text NOT NULL,
	"accepted_ru_en" text[] DEFAULT '{}'::text[] NOT NULL,
	"accepted_en_ru" text[] DEFAULT '{}'::text[] NOT NULL,
	"example" text,
	"explanation" text,
	"allow_omit_to" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_collections" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "source_collections_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"teacher_user_id" bigint NOT NULL,
	"title" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_cards" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "student_cards_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"student_collection_id" bigint NOT NULL,
	"source_card_id" bigint,
	"student_word_id" bigint,
	"position" integer NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_cards_one_per_source" UNIQUE("student_collection_id","source_card_id")
);
--> statement-breakpoint
CREATE TABLE "student_collections" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "student_collections_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"student_link_id" bigint NOT NULL,
	"source_collection_id" bigint NOT NULL,
	"title" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "student_collection_status" DEFAULT 'assigned' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_links" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "student_links_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"teacher_user_id" bigint NOT NULL,
	"display_name" text NOT NULL,
	"student_user_id" bigint,
	"status" "student_link_status" DEFAULT 'pending_connection' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_links_account_matches_status" CHECK (("student_links"."status" = 'pending_connection' AND "student_links"."student_user_id" IS NULL)
        OR ("student_links"."status" IN ('pending_confirmation', 'active') AND "student_links"."student_user_id" IS NOT NULL)
        OR "student_links"."status" = 'ended'),
	CONSTRAINT "student_links_dates_match_status" CHECK (("student_links"."status" <> 'active' OR "student_links"."started_at" IS NOT NULL)
        AND (("student_links"."status" = 'ended') = ("student_links"."ended_at" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "student_words" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "student_words_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"student_user_id" bigint NOT NULL,
	"normalized_english" text NOT NULL,
	"normalized_translation" text NOT NULL,
	"status" "word_status" DEFAULT 'learning' NOT NULL,
	"correct_streak" integer DEFAULT 0 NOT NULL,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"last_counted_session_id" bigint,
	"hard_since" timestamp with time zone,
	"mastered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_words_student_pair_unique" UNIQUE("student_user_id","normalized_english","normalized_translation"),
	CONSTRAINT "student_words_streak_non_negative" CHECK ("student_words"."correct_streak" >= 0),
	CONSTRAINT "student_words_errors_non_negative" CHECK ("student_words"."consecutive_errors" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"telegram_id" bigint NOT NULL,
	"role" "user_role",
	"telegram_first_name" text,
	"telegram_last_name" text,
	"telegram_username" text,
	"timezone" text,
	"reminder_time" time DEFAULT '19:00' NOT NULL,
	"reminders_enabled" boolean DEFAULT true NOT NULL,
	"bot_blocked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_telegram_id_unique" UNIQUE("telegram_id")
);
--> statement-breakpoint
CREATE TABLE "web_sessions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "web_sessions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint NOT NULL,
	"token_hash" text NOT NULL,
	"csrf_token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_student_link_id_student_links_id_fk" FOREIGN KEY ("student_link_id") REFERENCES "public"."student_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_versions" ADD CONSTRAINT "card_versions_student_card_id_student_cards_id_fk" FOREIGN KEY ("student_card_id") REFERENCES "public"."student_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_views" ADD CONSTRAINT "card_views_student_card_id_student_cards_id_fk" FOREIGN KEY ("student_card_id") REFERENCES "public"."student_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_views" ADD CONSTRAINT "card_views_card_version_id_card_versions_id_fk" FOREIGN KEY ("card_version_id") REFERENCES "public"."card_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_views" ADD CONSTRAINT "card_views_student_link_id_student_links_id_fk" FOREIGN KEY ("student_link_id") REFERENCES "public"."student_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_student_link_id_student_links_id_fk" FOREIGN KEY ("student_link_id") REFERENCES "public"."student_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_student_user_id_users_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_student_word_id_student_words_id_fk" FOREIGN KEY ("student_word_id") REFERENCES "public"."student_words"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_card_version_id_card_versions_id_fk" FOREIGN KEY ("card_version_id") REFERENCES "public"."card_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_student_user_id_users_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_student_link_id_student_links_id_fk" FOREIGN KEY ("student_link_id") REFERENCES "public"."student_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_student_collection_id_student_collections_id_fk" FOREIGN KEY ("student_collection_id") REFERENCES "public"."student_collections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_cards" ADD CONSTRAINT "source_cards_collection_id_source_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."source_collections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_collections" ADD CONSTRAINT "source_collections_teacher_user_id_users_id_fk" FOREIGN KEY ("teacher_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_cards" ADD CONSTRAINT "student_cards_student_collection_id_student_collections_id_fk" FOREIGN KEY ("student_collection_id") REFERENCES "public"."student_collections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_cards" ADD CONSTRAINT "student_cards_source_card_id_source_cards_id_fk" FOREIGN KEY ("source_card_id") REFERENCES "public"."source_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_cards" ADD CONSTRAINT "student_cards_student_word_id_student_words_id_fk" FOREIGN KEY ("student_word_id") REFERENCES "public"."student_words"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_collections" ADD CONSTRAINT "student_collections_student_link_id_student_links_id_fk" FOREIGN KEY ("student_link_id") REFERENCES "public"."student_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_collections" ADD CONSTRAINT "student_collections_source_collection_id_source_collections_id_fk" FOREIGN KEY ("source_collection_id") REFERENCES "public"."source_collections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_links" ADD CONSTRAINT "student_links_teacher_user_id_users_id_fk" FOREIGN KEY ("teacher_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_links" ADD CONSTRAINT "student_links_student_user_id_users_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_words" ADD CONSTRAINT "student_words_student_user_id_users_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_words" ADD CONSTRAINT "student_words_last_counted_session_id_sessions_id_fk" FOREIGN KEY ("last_counted_session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_log_target_idx" ON "admin_audit_log" USING btree ("target_user_id");--> statement-breakpoint
CREATE INDEX "attempts_link_idx" ON "attempts" USING btree ("student_link_id");--> statement-breakpoint
CREATE INDEX "card_views_card_idx" ON "card_views" USING btree ("student_card_id");--> statement-breakpoint
CREATE INDEX "card_views_link_idx" ON "card_views" USING btree ("student_link_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_one_active_request_per_student" ON "invitations" USING btree ("student_user_id") WHERE "invitations"."status" = 'awaiting_teacher';--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_one_live_per_link" ON "invitations" USING btree ("student_link_id") WHERE "invitations"."status" IN ('pending', 'awaiting_teacher');--> statement-breakpoint
CREATE INDEX "notifications_queue_idx" ON "notifications" USING btree ("next_attempt_at") WHERE "notifications"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "notifications_recipient_idx" ON "notifications" USING btree ("recipient_user_id");--> statement-breakpoint
CREATE INDEX "questions_word_idx" ON "questions" USING btree ("student_word_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_one_current_per_student" ON "sessions" USING btree ("student_user_id") WHERE "sessions"."status" = 'current';--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_one_quest_per_local_date" ON "sessions" USING btree ("student_user_id","quest_local_date") WHERE "sessions"."type" = 'daily_quest';--> statement-breakpoint
CREATE INDEX "sessions_link_idx" ON "sessions" USING btree ("student_link_id");--> statement-breakpoint
CREATE INDEX "source_cards_collection_idx" ON "source_cards" USING btree ("collection_id");--> statement-breakpoint
CREATE INDEX "source_collections_teacher_idx" ON "source_collections" USING btree ("teacher_user_id");--> statement-breakpoint
CREATE INDEX "student_cards_word_idx" ON "student_cards" USING btree ("student_word_id");--> statement-breakpoint
CREATE UNIQUE INDEX "student_collections_one_copy_per_link" ON "student_collections" USING btree ("student_link_id","source_collection_id") WHERE "student_collections"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "student_links_one_active_per_student" ON "student_links" USING btree ("student_user_id") WHERE "student_links"."status" = 'active';--> statement-breakpoint
CREATE INDEX "student_links_teacher_idx" ON "student_links" USING btree ("teacher_user_id","status");--> statement-breakpoint
CREATE INDEX "student_links_student_idx" ON "student_links" USING btree ("student_user_id");--> statement-breakpoint
CREATE INDEX "student_words_student_status_idx" ON "student_words" USING btree ("student_user_id","status");--> statement-breakpoint
CREATE INDEX "web_sessions_user_idx" ON "web_sessions" USING btree ("user_id");