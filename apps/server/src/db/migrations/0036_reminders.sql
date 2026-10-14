CREATE TABLE "push_devices" (
	"token" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"platform" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminder_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean NOT NULL,
	"daily_target" smallint NOT NULL,
	"days" smallint[] NOT NULL,
	"times" text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"local_day" date NOT NULL,
	"slot" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tickets" jsonb,
	"receipts" jsonb,
	"receipts_checked_at" timestamp with time zone,
	"tapped_at" timestamp with time zone,
	"session_id" text,
	CONSTRAINT "reminders_user_day_slot_key" UNIQUE("user_id","local_day","slot"),
	CONSTRAINT "reminders_outcome_known" CHECK ("reminders"."outcome" in ('claimed', 'sent', 'skip_target_met', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_settings" ADD CONSTRAINT "reminder_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_devices_user_idx" ON "push_devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "reminders_user_day_idx" ON "reminders" USING btree ("user_id","local_day");