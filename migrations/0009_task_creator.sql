-- 记录任务发布人（辅导员），便于多辅导员协作时区分是谁发布的任务
ALTER TABLE tasks ADD COLUMN created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON tasks(created_by);
