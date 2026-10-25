-- Fixed-size shared health state; preserve summaries, leases and consumed budgets.
ALTER TABLE work_budget ADD COLUMN failure_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE work_budget ADD COLUMN failure_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE work_budget ADD COLUMN recovery_remaining INTEGER NOT NULL DEFAULT 0;
