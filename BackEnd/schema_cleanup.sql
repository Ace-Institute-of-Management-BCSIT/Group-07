-- SaveABeat schema cleanup for the current application.
-- Run after taking a backup and after confirming the live database matches the
-- current schema structure.

-- Remove the obsolete chat subsystem.
DROP TABLE IF EXISTS chat_messages;

-- Preserve completed donation history if a donor profile is ever removed.
-- Allow the donor link to become NULL so admin deletions do not break history.
ALTER TABLE donation_history
  DROP FOREIGN KEY fk_history_donor;

ALTER TABLE donation_history
  MODIFY donor_id INT NULL;

ALTER TABLE donation_history
  ADD CONSTRAINT fk_history_donor
    FOREIGN KEY (donor_id) REFERENCES donor_profiles(donor_id)
    ON DELETE SET NULL;
