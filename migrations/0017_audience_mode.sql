-- 发布名单的勾选方式：
--   exclude = 勾选表示排除（默认，兼容旧数据）
--   include = 勾选表示只发给这些学员
-- 实际可见范围仍由 *_classes / *_exclusions 表决定：include 模式下会把未勾选的
-- 学员写入排除表，因此即使模式字段丢失（例如旧备份恢复）也不会改变实际范围。
-- 此字段仅用于再次编辑时还原界面。
ALTER TABLE tasks ADD COLUMN audience_mode TEXT NOT NULL DEFAULT 'exclude';
ALTER TABLE shares ADD COLUMN audience_mode TEXT NOT NULL DEFAULT 'exclude';
