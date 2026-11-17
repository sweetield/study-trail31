-- 资料分享：辅导员发布学习资料，学员按班级 / 排除名单查看。
-- 与学习任务分开建表，避免资料混入任务进度、步骤打卡与审核统计。
CREATE TABLE IF NOT EXISTS shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tech_tags TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'archived')),
  -- audience_all = 1 表示明确面向全部学员；0 且有班级记录表示仅这些班级。
  -- 这样删除班级时不会因为范围表变空而意外扩大成全体可见。
  audience_all INTEGER NOT NULL DEFAULT 1,
  pinned INTEGER NOT NULL DEFAULT 0,
  pinned_at INTEGER,
  pinned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  view_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_shares_status_created ON shares(status, pinned DESC, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_shares_creator ON shares(created_by, created_at DESC);

CREATE TABLE IF NOT EXISTS share_classes (
  share_id INTEGER NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  PRIMARY KEY (share_id, class_id)
);
CREATE INDEX IF NOT EXISTS idx_share_classes_class ON share_classes(class_id, share_id);

CREATE TABLE IF NOT EXISTS share_exclusions (
  share_id INTEGER NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (share_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_share_exclusions_user ON share_exclusions(user_id, share_id);

-- 访问量按“登录学员首次打开资料”计数，同一学员重复打开不重复累加。
CREATE TABLE IF NOT EXISTS share_views (
  share_id INTEGER NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (share_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_share_views_user ON share_views(user_id, share_id);
CREATE INDEX IF NOT EXISTS idx_share_views_share ON share_views(share_id, viewed_at DESC);

-- 附件表增加资料分享作用域。SQLite 无法直接修改 CHECK 约束，按既有迁移方式重建。
DROP INDEX IF EXISTS idx_files_log;
DROP INDEX IF EXISTS idx_files_progress;
DROP INDEX IF EXISTS idx_files_uploader;
DROP INDEX IF EXISTS idx_files_review;
DROP INDEX IF EXISTS idx_files_reply;

CREATE TABLE files_new (
  id TEXT PRIMARY KEY,
  uploader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('log', 'progress', 'task', 'review', 'reply', 'share')),
  log_id INTEGER REFERENCES study_logs(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  share_id INTEGER REFERENCES shares(id) ON DELETE CASCADE,
  reply_id INTEGER REFERENCES log_replies(id) ON DELETE CASCADE,
  review_event_id INTEGER REFERENCES progress_events(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  iv TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO files_new (id, uploader_id, owner_user_id, scope, log_id, task_id, share_id, reply_id, review_event_id, name, mime, size, iv, r2_key, created_at)
SELECT id, uploader_id, owner_user_id, scope, log_id, task_id, NULL, reply_id, review_event_id, name, mime, size, iv, r2_key, created_at
  FROM files;

DROP TABLE files;
ALTER TABLE files_new RENAME TO files;

CREATE INDEX IF NOT EXISTS idx_files_log ON files(log_id);
CREATE INDEX IF NOT EXISTS idx_files_progress ON files(task_id, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_files_uploader ON files(uploader_id, created_at);
CREATE INDEX IF NOT EXISTS idx_files_review ON files(scope, task_id, owner_user_id, review_event_id);
CREATE INDEX IF NOT EXISTS idx_files_reply ON files(reply_id);
CREATE INDEX IF NOT EXISTS idx_files_owner_size ON files(owner_user_id, size);
CREATE INDEX IF NOT EXISTS idx_files_share ON files(share_id);
