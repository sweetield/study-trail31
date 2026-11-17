-- 管理端文件明细：支持按大小 / 上传时间排序的分页浏览
-- 索引与查询的 ORDER BY 保持一致，避免每次翻页都全表排序
CREATE INDEX IF NOT EXISTS idx_files_size_id ON files(size DESC, id);
CREATE INDEX IF NOT EXISTS idx_files_created_id ON files(created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_files_scope_size_id ON files(scope, size DESC, id);
