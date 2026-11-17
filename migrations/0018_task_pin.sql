-- 任务置顶：置顶任务在学员列表中排在最前，优先于高优先级任务
ALTER TABLE tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN pinned_at INTEGER;
ALTER TABLE tasks ADD COLUMN pinned_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_pinned ON tasks(pinned DESC, pinned_at DESC);
