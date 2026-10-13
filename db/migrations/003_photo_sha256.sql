-- 003_photo_sha256: the sha256 of every photo uploaded through the API. A re-upload of a stored
-- path is accepted only with identical bytes (the phone's outbox retrying), so nobody holding the
-- trip link can replace a closest-to-pin photo or any other evidence after the fact.
-- Rows from before this migration have null (those are checked by size instead).
--
-- Idempotent, never shipped to clients (same rules as 001).

alter table photo_uploads add column if not exists sha256 text;
