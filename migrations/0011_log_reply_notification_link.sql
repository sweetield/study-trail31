-- 让“辅导员回复学习日志”的站内通知直接定位到具体日志，而不是只打开日志列表。
-- 同时避免应用层和触发器各插入一条通知造成重复提醒。
DROP TRIGGER IF EXISTS trg_notify_log_reply;

CREATE TRIGGER trg_notify_log_reply AFTER INSERT ON log_replies
WHEN (SELECT role FROM users WHERE id = NEW.user_id) = 'admin'
BEGIN
  INSERT INTO notifications (user_id, kind, title, link)
  SELECT l.user_id, 'reply', s.name || ' 回复了你的学习日志 · ' || l.log_date, '/app/logs?log=' || l.id
    FROM study_logs l
    JOIN users s ON s.id = NEW.user_id
   WHERE l.id = NEW.log_id AND l.user_id <> NEW.user_id;
END;
