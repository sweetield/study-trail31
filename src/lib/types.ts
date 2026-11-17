export type ProgressStatus = "doing" | "submitted" | "approved" | "rejected";

export interface Me {
  id: number;
  username: string;
  name: string;
  role: "admin" | "student";
  /** 管理员：可访问团队与安全、数据备份并管理学员账号 */
  is_super_admin?: boolean;
  class_id: number | null;
  class_name: string | null;
  avatar_id: string | null;
  must_change_password: boolean;
}

export interface StudentTask {
  id: number;
  title: string;
  tech_tags: string;
  due_date: string | null;
  require_review: number;
  priority: number;
  /** 是否置顶，置顶任务排在高优先级任务之前 */
  pinned: number;
  pinned_at: number | null;
  created_at: number;
  step_count: number;
  status: ProgressStatus | null;
  percent: number;
  updated_at: number | null;
  review_comment: string | null;
  score: number | null;
  /** 发布任务的辅导员 */
  creator_name?: string | null;
  /** 辅导员最近一次督促的倒计时截止时间（Unix 秒） */
  urge_due_at?: number | null;
  urge_message?: string | null;
}

export interface Step {
  id: number;
  title: string;
  position: number;
  done?: boolean;
}

export interface Progress {
  task_id: number;
  user_id: number;
  status: ProgressStatus;
  percent: number;
  note: string;
  link: string;
  review_comment: string;
  score: number | null;
  submitted_at: number | null;
  reviewed_at: number | null;
  updated_at: number;
  /** 审核该进度的辅导员 */
  reviewer_id?: number | null;
  reviewer_name?: string | null;
  reviewer_avatar_id?: string | null;
}

export interface ProgressEvent {
  id: number;
  action: "submit" | "withdraw" | "approve" | "reject";
  comment: string;
  score: number | null;
  actor_name: string | null;
  actor_avatar_id?: string | null;
  created_at: number;
}

export interface TaskLeaderboardEntry {
  id: number;
  name: string;
  avatar_id: string | null;
  status: ProgressStatus | null;
  percent: number;
  rank: number;
  is_me: boolean;
}

export interface TaskLeaderboardData {
  class_name: string | null;
  total: number;
  top: TaskLeaderboardEntry[];
  me: TaskLeaderboardEntry | null;
}

export interface AppNotification {
  id: number;
  kind: "task" | "submit" | "approve" | "reject" | "reply" | "urge" | "activity" | "share";
  title: string;
  link: string;
  read_at: number | null;
  created_at: number;
}

export interface StudyLog {
  id: number;
  /** 日志所属学员（管理员查看时返回） */
  user_id?: number;
  minutes: number;
  content: string;
  log_date: string;
  created_at?: number;
  task_id?: number | null;
  task_title?: string | null;
  /** 学员是否仍可编辑：已有更新的日志或辅导员留言后为 false */
  editable?: boolean;
  /** 是否存在辅导员留言（列表页按需加载留言时使用） */
  has_replies?: boolean;
  files?: FileMeta[];
  replies?: LogReply[];
}

export interface FileMeta {
  id: string;
  /** 实际上传者；用于区分学员附件与辅导员批注附件 */
  uploader_id?: number;
  name: string;
  mime: string;
  size: number;
  created_at: number;
}

export interface LogReply {
  id: number;
  /** 被回复的留言；为空表示辅导员的顶层留言 */
  parent_id?: number | null;
  content: string;
  created_at: number;
  /** 留言作者的账号 ID */
  user_id?: number;
  author_name: string;
  author_role?: "admin" | "student" | string | null;
  author_avatar_id?: string | null;
  files?: FileMeta[];
}

export interface ClassItem {
  id: number;
  name: string;
  student_count: number;
}

export interface AdminTask {
  id: number;
  title: string;
  tech_tags: string;
  class_id: number | null;
  class_name: string | null;
  class_names: string | null;
  due_date: string | null;
  status: "draft" | "published" | "archived";
  require_review: number;
  priority: number;
  /** 是否置顶，置顶任务排在高优先级任务之前 */
  pinned: number;
  pinned_at: number | null;
  created_at: number;
  /** 发布该任务的辅导员 */
  creator_name?: string | null;
  step_count: number;
  assigned: number;
  approved: number;
  submitted: number;
  doing: number;
}

export interface StorageScopeUsage {
  scope: string;
  bytes: number;
  count: number;
}

export interface StorageStudentUsage {
  id: number;
  username: string;
  name: string;
  class_id: number | null;
  class_name: string | null;
  active: number;
  file_bytes: number;
  file_count: number;
  avatar_bytes: number;
  total_bytes: number;
  last_upload_at: number | null;
}

export interface StorageFileItem {
  id: string;
  name: string;
  mime: string;
  size: number;
  scope: string;
  owner_user_id: number;
  owner_name: string | null;
  owner_username: string | null;
  uploader_id: number;
  log_id: number | null;
  task_id: number | null;
  share_id: number | null;
  reply_id: number | null;
  review_event_id: number | null;
  created_at: number;
}

export interface StorageFilePage {
  files: StorageFileItem[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface AdminStorageData {
  storage: {
    backend: "r2" | "kv" | null;
    label: string;
    available: ("r2" | "kv")[];
    total_bytes: number;
    total_source: "env" | "default";
    used_bytes: number;
    free_bytes: number;
    percent: number;
    attachment_bytes: number;
    avatar_bytes: number;
    file_count: number;
    avatar_count: number;
    scope_quota_bytes: number;
    student_quota_bytes: number;
  };
  scopes: StorageScopeUsage[];
  students: StorageStudentUsage[];
  generated_at: number;
}

export interface AdminStudent {
  id: number;
  username: string;
  name: string;
  class_id: number | null;
  class_name: string | null;
  avatar_id: string | null;
  active: number;
  must_change_password: number;
  last_login_at: number | null;
  last_active_at: number | null;
  assigned: number;
  completed: number;
  minutes: number;
}

/** 发布任务 / 资料时选择名单使用的轻量学员字段 */
export interface AudienceStudent {
  id: number;
  username: string;
  name: string;
  class_id: number | null;
  class_name: string | null;
  active: number;
}

export type ShareStatus = "draft" | "published" | "archived";

/** 发布名单勾选方式：排除勾选学员，或只发给勾选学员 */
export type AudienceMode = "exclude" | "include";

export interface AdminShare {
  id: number;
  title: string;
  tech_tags: string;
  excerpt: string;
  status: ShareStatus;
  audience_all: number;
  audience_mode: AudienceMode;
  pinned: number;
  pinned_at: number | null;
  view_count: number;
  created_at: number;
  updated_at: number;
  creator_name: string | null;
  class_names: string | null;
  file_count: number;
}

export interface Share {
  id: number;
  title: string;
  tech_tags: string;
  pinned: number;
  view_count: number;
  created_at: number;
  updated_at: number;
  excerpt: string;
  creator_name: string | null;
  file_count: number;
}

export interface ShareDetail {
  share: {
    id: number;
    title: string;
    description: string;
    tech_tags: string;
    status: ShareStatus;
    audience_all: number;
    pinned: number;
    view_count: number;
    created_at: number;
    updated_at: number;
    creator_name: string | null;
    creator_avatar_id?: string | null;
    class_names?: string | null;
  };
  files: FileMeta[];
}

