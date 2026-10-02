CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"severity" text NOT NULL,
	"code" text NOT NULL,
	"message" text NOT NULL,
	"account_id" uuid,
	"route_id" uuid,
	"job_id" uuid,
	"dedup_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"detail" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bridge_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"command" jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"deliveries" integer DEFAULT 0 NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "bridge_commands_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "bridge_nonces" (
	"token_id" text NOT NULL,
	"nonce" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bridge_nonces_token_id_nonce_pk" PRIMARY KEY("token_id","nonce")
);
--> statement-breakpoint
CREATE TABLE "connection_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"requested_by" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "copier_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"master_account_id" uuid NOT NULL,
	"entries_paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copy_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"route_id" uuid NOT NULL,
	"master_account_id" uuid NOT NULL,
	"follower_account_id" uuid NOT NULL,
	"master_key" text NOT NULL,
	"master_position_id" text,
	"master_order_id" text,
	"follower_position_id" text,
	"follower_order_id" text,
	"client_id" text NOT NULL,
	"master_symbol" text NOT NULL,
	"follower_symbol" text NOT NULL,
	"side" text NOT NULL,
	"master_volume_initial" double precision NOT NULL,
	"master_volume_current" double precision NOT NULL,
	"follower_volume_initial" double precision NOT NULL,
	"follower_volume_current" double precision NOT NULL,
	"master_open_price" double precision,
	"follower_open_price" double precision,
	"status" text NOT NULL,
	"status_detail" text,
	"realized_pnl" double precision,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_baselines" (
	"account_id" uuid NOT NULL,
	"day_key" text NOT NULL,
	"baseline" double precision NOT NULL,
	"balance" double precision NOT NULL,
	"equity" double precision NOT NULL,
	"late" boolean DEFAULT false NOT NULL,
	"breached_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_baselines_account_id_day_key_pk" PRIMARY KEY("account_id","day_key")
);
--> statement-breakpoint
CREATE TABLE "device_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"token_id" text NOT NULL,
	"secret_enc" text NOT NULL,
	"label" text NOT NULL,
	"scope" text DEFAULT 'bridge:account' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_ip" text,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "device_tokens_token_id_unique" UNIQUE("token_id")
);
--> statement-breakpoint
CREATE TABLE "engine_heartbeats" (
	"instance_id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_beat_at" timestamp with time zone NOT NULL,
	"version" text NOT NULL,
	"live_trading_enabled" boolean NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engine_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"level" text NOT NULL,
	"component" text NOT NULL,
	"message" text NOT NULL,
	"context" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"master_event_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"follower_account_id" uuid NOT NULL,
	"ordering_key" text NOT NULL,
	"seq" bigint NOT NULL,
	"event_type" text NOT NULL,
	"state" text NOT NULL,
	"client_id" text NOT NULL,
	"command" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"reconcile_attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"reason" text,
	"detail" jsonb,
	"follower_order_id" text,
	"follower_position_id" text,
	"requested_volume" double precision,
	"filled_volume" double precision,
	"master_price" double precision,
	"fill_price" double precision,
	"price_diff_points" double precision,
	"master_time" timestamp with time zone,
	"detected_at" timestamp with time zone,
	"queued_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"filled_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_jobs_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"account_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"spec" jsonb NOT NULL,
	"bid" double precision,
	"ask" double precision,
	"quote_time" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instruments_account_id_symbol_pk" PRIMARY KEY("account_id","symbol")
);
--> statement-breakpoint
CREATE TABLE "job_transitions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "master_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"account_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"source" text NOT NULL,
	"target_route_id" uuid,
	"platform_time" timestamp with time zone,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"routed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "master_snapshots" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"snapshot" jsonb NOT NULL,
	"baseline_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"aliases" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"baseline_taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"follower_account_id" uuid NOT NULL,
	"settings" jsonb NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"entries_paused" boolean DEFAULT false NOT NULL,
	"previewed_at" timestamp with time zone,
	"settings_version" integer DEFAULT 1 NOT NULL,
	"previewed_version" integer,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "symbol_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"master_account_id" uuid NOT NULL,
	"follower_account_id" uuid NOT NULL,
	"master_symbol" text NOT NULL,
	"follower_symbol" text NOT NULL,
	"status" text DEFAULT 'SUGGESTED' NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trading_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nickname" text NOT NULL,
	"platform" text NOT NULL,
	"environment" text NOT NULL,
	"account_class" text NOT NULL,
	"broker_name" text NOT NULL,
	"external_account_id" text NOT NULL,
	"server" text,
	"api_base_url" text,
	"credentials_enc" text,
	"session_enc" text,
	"currency" text,
	"balance" double precision,
	"equity" double precision,
	"free_margin" double precision,
	"margin_used" double precision,
	"accounting" text DEFAULT 'UNKNOWN' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"connection_status" text DEFAULT 'NOT_CONFIGURED' NOT NULL,
	"status_detail" text,
	"capabilities" jsonb,
	"risk_config" jsonb NOT NULL,
	"live_execution_armed" boolean DEFAULT false NOT NULL,
	"entries_paused" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"two_factor_enabled" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_commands" ADD CONSTRAINT "bridge_commands_account_id_trading_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copier_groups" ADD CONSTRAINT "copier_groups_master_account_id_trading_accounts_id_fk" FOREIGN KEY ("master_account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_links" ADD CONSTRAINT "copy_links_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_baselines" ADD CONSTRAINT "daily_baselines_account_id_trading_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_account_id_trading_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_jobs" ADD CONSTRAINT "execution_jobs_master_event_id_master_events_id_fk" FOREIGN KEY ("master_event_id") REFERENCES "public"."master_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_jobs" ADD CONSTRAINT "execution_jobs_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_jobs" ADD CONSTRAINT "execution_jobs_follower_account_id_trading_accounts_id_fk" FOREIGN KEY ("follower_account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_account_id_trading_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_transitions" ADD CONSTRAINT "job_transitions_job_id_execution_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."execution_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_events" ADD CONSTRAINT "master_events_account_id_trading_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_snapshots" ADD CONSTRAINT "master_snapshots_account_id_trading_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_group_id_copier_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."copier_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_follower_account_id_trading_accounts_id_fk" FOREIGN KEY ("follower_account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "symbol_mappings" ADD CONSTRAINT "symbol_mappings_master_account_id_trading_accounts_id_fk" FOREIGN KEY ("master_account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "symbol_mappings" ADD CONSTRAINT "symbol_mappings_follower_account_id_trading_accounts_id_fk" FOREIGN KEY ("follower_account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_dedup" ON "alerts" USING btree ("dedup_key");--> statement-breakpoint
CREATE INDEX "alerts_open" ON "alerts" USING btree ("acknowledged_at");--> statement-breakpoint
CREATE INDEX "audit_log_at" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "bridge_commands_pending" ON "bridge_commands" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "bridge_nonces_seen" ON "bridge_nonces" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "connection_events_account" ON "connection_events" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "control_commands_pending" ON "control_commands" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "copy_links_route_master" ON "copy_links" USING btree ("route_id","master_key");--> statement-breakpoint
CREATE INDEX "copy_links_follower_pos" ON "copy_links" USING btree ("follower_account_id","follower_position_id");--> statement-breakpoint
CREATE INDEX "engine_logs_at" ON "engine_logs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_jobs_event_route" ON "execution_jobs" USING btree ("master_event_id","route_id");--> statement-breakpoint
CREATE INDEX "execution_jobs_claim" ON "execution_jobs" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "execution_jobs_ordering" ON "execution_jobs" USING btree ("ordering_key","seq");--> statement-breakpoint
CREATE INDEX "job_transitions_job" ON "job_transitions" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_events_dedup" ON "master_events" USING btree ("account_id","event_key");--> statement-breakpoint
CREATE INDEX "master_events_unrouted" ON "master_events" USING btree ("routed_at") WHERE routed_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "routes_group_follower" ON "routes" USING btree ("group_id","follower_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "symbol_mappings_pair" ON "symbol_mappings" USING btree ("master_account_id","follower_account_id","master_symbol");--> statement-breakpoint
CREATE UNIQUE INDEX "trading_accounts_identity" ON "trading_accounts" USING btree ("platform","environment","server","external_account_id");