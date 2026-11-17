-- 附件支持更多使用场景：
-- scope = log      学习日志附件 / 辅导员对日志的批注附件
-- scope = progress 任务作品附件
-- scope = task     任务说明附件（图片会直接显示在任务说明中）
-- scope = review   辅导员审核批注附件，审核完成后通过 review_event_id 绑定到审核记录
DROP INDEX IF EXISTS idx_files_log;
DROP INDEX IF EXISTS idx_files_progress;
DROP INDEX IF EXISTS idx_files_uploader;

CREATE TABLE files_new (
  id TEXT PRIMARY KEY,
  uploader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('log', 'progress', 'task', 'review')),
  log_id INTEGER REFERENCES study_logs(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  review_event_id INTEGER REFERENCES progress_events(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  iv TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO files_new (id, uploader_id, owner_user_id, scope, log_id, task_id, review_event_id, name, mime, size, iv, r2_key, created_at)
SELECT id, uploader_id, owner_user_id, scope, log_id, task_id, NULL, name, mime, size, iv, r2_key, created_at
  FROM files;

DROP TABLE files;
ALTER TABLE files_new RENAME TO files;

CREATE INDEX IF NOT EXISTS idx_files_log ON files(log_id);
CREATE INDEX IF NOT EXISTS idx_files_progress ON files(task_id, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_files_uploader ON files(uploader_id, created_at);
CREATE INDEX IF NOT EXISTS idx_files_review ON files(scope, task_id, owner_user_id, review_event_id);

-- 学员有新的学习动态时，给所有在职辅导员发送站内通知。
-- 点击通知会直接定位到对应学员的动态 / 学习日志。
CREATE TRIGGER IF NOT EXISTS trg_notify_admin_study_log AFTER INSERT ON study_logs
BEGIN
  INSERT INTO notifications (user_id, kind, title, link)
  SELECT a.id, 'activity',
         s.name || ' 打卡了学习日志' || CASE WHEN t.title IS NOT NULL THEN ' · ' || t.title ELSE '' END,
         '/admin/students/' || NEW.user_id || '?log=' || NEW.id
    FROM users a
    JOIN users s ON s.id = NEW.user_id
    LEFT JOIN tasks t ON t.id = NEW.task_id
   WHERE a.role = 'admin' AND a.active = 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_notify_admin_progress_insert AFTER INSERT ON progress
WHEN NEW.status = 'doing'
BEGIN
  INSERT INTO notifications (user_id, kind, title, link)
  SELECT a.id, 'activity', s.name || ' 开始学习《' || t.title || '》',
         '/admin/students/' || NEW.user_id || '?task=' || NEW.task_id
    FROM users a, users s, tasks t
   WHERE a.role = 'admin' AND a.active = 1 AND s.id = NEW.user_id AND t.id = NEW.task_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_notify_admin_progress_update AFTER UPDATE OF percent ON progress
WHEN NEW.percent <> OLD.percent AND NEW.status IN ('doing', 'rejected')
BEGIN
  INSERT INTO notifications (user_id, kind, title, link)
  SELECT a.id, 'activity', s.name || ' 更新了《' || t.title || '》的进度（' || NEW.percent || '%）',
         '/admin/students/' || NEW.user_id || '?task=' || NEW.task_id
    FROM users a, users s, tasks t
   WHERE a.role = 'admin' AND a.active = 1 AND s.id = NEW.user_id AND t.id = NEW.task_id;
END;
