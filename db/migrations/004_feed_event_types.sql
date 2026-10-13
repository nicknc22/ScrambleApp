-- 004_feed_event_types: two new automatic feed event types.
--
--   results_changed  a batch applied to a FINAL trip (a phone syncing plays from the course after
--                    the finalize, or a commissioner fix) changed the champion, the standings or
--                    the settle-up. Loud on purpose: people may already have paid.
--   removed          a drink, contest entry or mulligan was removed by someone other than whoever
--                    logged it, or long after the 10-second undo (transparency).
--
-- Re-creates the type CHECK constraint from 001 with the full list. Idempotent.

alter table feed_events drop constraint if exists feed_events_type_check;
alter table feed_events add constraint feed_events_type_check check (type in (
  'post', 'round_started', 'tee_off', 'score_notable', 'score_edit', 'drinks', 'shotgun', 'shot',
  'ghost_beer', 'mulligan_used', 'groom_mulligan', 'lead_change', 'contest_entry', 'contest_lead',
  'ai_judge', 'drive_warning', 'drive_miss', 'commissioner_override', 'round_complete',
  'final_results', 'results_changed', 'removed', 'roast'
));
