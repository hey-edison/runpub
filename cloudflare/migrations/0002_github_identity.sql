ALTER TABLE accounts ADD COLUMN github_user_id TEXT;

CREATE UNIQUE INDEX accounts_github_user_id_idx
  ON accounts(github_user_id)
  WHERE github_user_id IS NOT NULL;
