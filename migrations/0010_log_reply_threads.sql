-- 学习日志留言支持楼中楼回复与附件：
-- 1. log_replies.parent_id 指向被回复的留言（学员可以针对辅导员留言回复）
-- 2. files.scope 增加 reply，留言图片 / 文件通过 reply_id 绑定
ALTER TABLE log_replies ADD COLUMN parent_id INTEGER REFERENCES log_replies(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_log_replies_parent ON log_replies(parent_id);

DROP INDEX IF EXISTS idx_files_log;
DROP INDEX IF EXISTS idx_files_progress;
DROP INDEX IF EXISTS idx_files_uploader;

CREATE TABLE files_new (
  id TEXT PRIMARY KEY,
  uploader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('log', 'progress', 'task', 'review', 'reply')),
  log_id INTEGER REFERENCES study_logs(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  reply_id INTEGER REFERENCES log_replies(id) ON DELETE CASCADE,
  review_event_id INTEGER REFERENCES progress_events(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  iv TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO files_new (id, uploader_id, owner_user_id, scope, log_id, task_id, reply_id, review_event_id, name, mime, size, iv, r2_key, created_at)
SELECT id, uploader_id, owner_user_id, scope, log_id, task_id, NULL, review_event_id, name, mime, size, iv, r2_key, created_at
  FROM files;

DROP TABLE files;
ALTER TABLE files_new RENAME TO files;

CREATE INDEX IF NOT EXISTS idx_files_log ON files(log_id);
CREATE INDEX IF NOT EXISTS idx_files_progress ON files(task_id, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_files_uploader ON files(uploader_id, created_at);
CREATE INDEX IF NOT EXISTS idx_files_review ON files(scope, task_id, owner_user_id, review_event_id);
CREATE INDEX IF NOT EXISTS idx_files_reply ON files(reply_id);

-- 学员回复学习日志留言后，通知所有在职辅导员
CREATE TRIGGER IF NOT EXISTS trg_notify_admin_log_reply AFTER INSERT ON log_replies
WHEN (SELECT role FROM users WHERE id = NEW.user_id) = 'student'
BEGIN
  INSERT INTO notifications (user_id, kind, title, link)
  SELECT a.id, 'reply', s.name || ' 回复了学习日志留言',
         '/admin/students/' || l.user_id || '?log=' || l.id
    FROM users a
    JOIN study_logs l ON l.id = NEW.log_id
    JOIN users s ON s.id = NEW.user_id
   WHERE a.role = 'admin' AND a.active = 1;
END;
