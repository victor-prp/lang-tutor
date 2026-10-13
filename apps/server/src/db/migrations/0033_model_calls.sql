CREATE TABLE "model_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"session_id" uuid,
	"attempt" integer,
	"enrollment_id" text,
	"user_id" text,
	"request" jsonb NOT NULL,
	"response" jsonb,
	"http_status" integer,
	"error" text,
	"duration_ms" integer NOT NULL,
	"prompt_tokens" integer,
	"output_tokens" integer,
	"thinking_tokens" integer,
	"finish_reason" text
);
--> statement-breakpoint
CREATE INDEX "model_calls_session_idx" ON "model_calls" USING btree ("session_id","started_at");--> statement-breakpoint
CREATE INDEX "model_calls_enrollment_idx" ON "model_calls" USING btree ("enrollment_id","started_at");--> statement-breakpoint
CREATE INDEX "model_calls_user_idx" ON "model_calls" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "model_calls_kind_idx" ON "model_calls" USING btree ("kind","started_at");--> statement-breakpoint
CREATE INDEX "model_calls_started_idx" ON "model_calls" USING btree ("started_at");