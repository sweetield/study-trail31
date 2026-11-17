-- 管理端存储用量：按学员汇总附件大小
CREATE INDEX IF NOT EXISTS idx_files_owner_size ON files(owner_user_id, size);
