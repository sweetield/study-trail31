-- 日志分页与归档相关的读取优化
-- 1) 学员日志按 (user_id, log_date DESC, id DESC) 走索引，翻页时不再扫描整段历史
DROP INDEX IF EXISTS idx_logs_user_date;
CREATE INDEX IF NOT EXISTS idx_logs_user_date ON study_logs(user_id, log_date DESC, id DESC);

-- 2) 按任务筛选日志并分页
CREATE INDEX IF NOT EXISTS idx_logs_user_task ON study_logs(user_id, task_id, log_date DESC, id DESC);

-- 3) “是否还有更新的日志”判断（n.id > l.id）按学员 + id 查找
CREATE INDEX IF NOT EXISTS idx_logs_user_id ON study_logs(user_id, id DESC);

-- 4) 学期归档：按 log_date 统计与删除旧日志
CREATE INDEX IF NOT EXISTS idx_logs_date ON study_logs(log_date);

-- 5) 通知按链接精确查找：删除日志时同步清理指向它的站内通知，
--    避免“死链未读”长期占用未读计数（学员链接与辅导员链接两种格式都覆盖）
CREATE INDEX IF NOT EXISTS idx_notifications_link ON notifications(link);

CREATE TRIGGER IF NOT EXISTS trg_notifications_log_delete AFTER DELETE ON study_logs
BEGIN
  DELETE FROM notifications
   WHERE link = '/app/logs?log=' || OLD.id
      OR link = '/admin/students/' || OLD.user_id || '?log=' || OLD.id;
END;
