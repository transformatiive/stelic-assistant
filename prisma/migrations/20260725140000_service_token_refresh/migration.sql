-- The service credential can now be connected through the app rather than pasted into an
-- environment variable. A refresh token is bound to the OAuth client that issued it, so one
-- obtained any other way cannot be refreshed by this app — which is exactly the failure this
-- migration exists to make impossible.
ALTER TABLE "service_tokens"
  ADD COLUMN "refresh_token_encrypted" TEXT,
  ADD COLUMN "connected_by_user_id" TEXT,
  ADD COLUMN "connected_at" TIMESTAMP(3);

-- The access token is only ever a cache of a refresh, so a row can now exist before one has
-- been fetched.
ALTER TABLE "service_tokens" ALTER COLUMN "access_token_encrypted" DROP NOT NULL;
ALTER TABLE "service_tokens" ALTER COLUMN "expires_at" DROP NOT NULL;
