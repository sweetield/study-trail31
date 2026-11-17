-- 管理员 / 辅导员分级：只有管理员可以管理团队、数据备份与学员账号。
-- 升级时把最早创建且仍可用的管理账号设为管理员，其余管理账号继续作为辅导员使用。
ALTER TABLE users ADD COLUMN is_super_admin INTEGER DEFAULT 0;

UPDATE users
   SET is_super_admin = 1
 WHERE id = (SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1);

-- 概览活动流按最近 7 天过滤，避免全表扫描 progress。
CREATE INDEX IF NOT EXISTS idx_progress_updated ON progress(updated_at);