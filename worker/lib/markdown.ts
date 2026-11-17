export interface ExportFile {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface ExportReply {
  author_name: string;
  author_role?: string | null;
  content: string;
  created_at: number;
  parent_id?: number | null;
  files?: ExportFile[];
}

export interface ExportLog {
  log_date: string;
  minutes: number;
  content: string;
  files: ExportFile[];
  replies: ExportReply[];
}

export interface StudentExportTask {
  id: number;
  title: string;
  description: string;
  tech_tags: string;
  due_date: string | null;
  require_review: number;
  steps: { title: string; done: boolean }[];
  progress: {
    status: string;
    percent: number;
    note: string;
    link: string;
    review_comment: string;
    score: number | null;
    submitted_at: number | null;
    reviewed_at: number | null;
  } | null;
  files: ExportFile[];
  task_files: ExportFile[];
  review_files: ExportFile[];
  logs: ExportLog[];
}

export interface AdminExportRow {
  name: string;
  username: string;
  class_name: string | null;
  status: string | null;
  percent: number;
  note: string | null;
  link: string | null;
  review_comment: string | null;
  score: number | null;
  submitted_at: number | null;
  reviewed_at: number | null;
  files: ExportFile[];
  review_files: ExportFile[];
  logs: ExportLog[];
}

export interface AdminExportTask {
  id: number;
  title: string;
  description: string;
  tech_tags: string;
  due_date: string | null;
  status: string;
  require_review: number;
  class_names: string | null;
  steps: { title: string }[];
  taskFiles: ExportFile[];
  rows: AdminExportRow[];
}

export interface ShareExportItem {
  id: number;
  title: string;
  description: string;
  tech_tags: string;
  status?: string | null;
  audience_all?: number | null;
  class_names?: string | null;
  creator_name?: string | null;
  view_count?: number | null;
  created_at?: number | null;
  updated_at?: number | null;
  files: ExportFile[];
}

const PROGRESS_LABEL: Record<string, string> = {
  doing: "进行中",
  submitted: "待审核",
  approved: "已完成",
  rejected: "需修改",
};

const TASK_LABEL: Record<string, string> = {
  draft: "草稿",
  published: "已发布",
  archived: "已归档",
};

export function parseIdList(value: string | undefined, max = 200): number[] {
  if (!value) return [];
  const ids = value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(ids)].slice(0, max);
}

export function parseTaskIds(value: string | undefined): number[] {
  return parseIdList(value);
}

export function parseShareIds(value: string | undefined): number[] {
  return parseTaskIds(value);
}

/**
 * 把导出 Markdown 里的线上附件链接（/api/files/:id 或带域名的完整链接）
 * 替换为 ZIP 压缩包内的本地相对路径，确保图片和附件离线可读。
 */
export function applyLocalFilePaths(markdown: string, paths: Map<string, string>): string {
  if (!paths.size) return markdown;
  return markdown.replace(
    /(?:https?:\/\/[^\s)"']+?)?\/api\/files\/([a-f0-9]{32})/g,
    (whole: string, id: string) => paths.get(id) ?? whole,
  );
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

/** 学习日志允许把时长留空表示“未知” */
export function formatLogMinutes(minutes: number): string {
  return minutes > 0 ? formatMinutes(minutes) : "未知";
}

function scoreText(score: number | null): string {
  if (!score) return "未评分";
  return `${"★".repeat(score)}${"☆".repeat(Math.max(0, 5 - score))}（${score}/5）`;
}

function block(text: string | null | undefined): string {
  const value = (text ?? "").trim();
  return value ? value.replace(/\r\n/g, "\n") : "（未填写）";
}

function fileUrl(origin: string, id: string): string {
  return `${origin.replace(/\/$/, "")}/api/files/${id}`;
}

function escapeAlt(name: string): string {
  return name.replace(/[[\]\\]/g, "\\$&");
}

/** 图片直接使用 Markdown 图片语法内嵌，其他文件以链接形式列出 */
function fileBlock(files: ExportFile[], origin: string, content?: string | null): string {
  if (!files.length) return "";
  // 正文中已经内嵌引用的附件不再重复列出
  const referenced = new Set<string>();
  if (content) {
    const pattern = /\/api\/files\/([a-f0-9]{32})/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content))) referenced.add(match[1]);
  }
  const pending = files.filter((file) => !referenced.has(file.id));
  if (!pending.length) return "";
  const images = pending.filter((file) => /^image\//i.test(file.mime));
  const others = pending.filter((file) => !/^image\//i.test(file.mime));
  const parts: string[] = [];
  if (images.length) {
    parts.push(images.map((file) => `![${escapeAlt(file.name)}](${fileUrl(origin, file.id)})`).join("\n\n"));
  }
  if (others.length) {
    parts.push(others.map((file) => `- [${file.name}](${fileUrl(origin, file.id)}) · ${formatBytes(file.size)}`).join("\n"));
  }
  return parts.join("\n\n");
}

function replyLines(replies: ExportReply[], origin: string): string {
  if (!replies.length) return "";
  return replies
    .map((reply) => {
      const indent = reply.parent_id ? "  " : "";
      const role = reply.author_role === "student" ? "学员" : "辅导员";
      let line = `${indent}- **${reply.author_name}**（${role} · ${formatDateTime(reply.created_at)}）：${block(reply.content)}`;
      const files = fileBlock(reply.files ?? [], origin, reply.content);
      if (files) line += `\n${files.split("\n").map((part) => (part ? `${indent}  ${part}` : part)).join("\n")}`;
      return line;
    })
    .join("\n");
}

function logSection(logs: ExportLog[], origin: string, heading = "####"): string {
  if (!logs.length) return "（暂无学习日志）\n";
  return logs
    .map((log) => {
      const parts = [`${heading} ${log.log_date} · ${formatLogMinutes(log.minutes)}`, "", block(log.content)];
      const files = fileBlock(log.files, origin, log.content);
      if (files) parts.push("", "**附件：**", files);
      const replies = replyLines(log.replies, origin);
      if (replies) parts.push("", "**留言与回复：**", replies);
      return parts.join("\n");
    })
    .join("\n\n");
}

function stepSection(steps: { title: string; done?: boolean }[]): string {
  if (!steps.length) return "（无固定步骤，由学员手动填写进度）\n";
  return steps.map((step, index) => `- [${step.done ? "x" : " "}] ${index + 1}. ${step.title}`).join("\n");
}

export function buildStudentMarkdown(userName: string, tasks: StudentExportTask[], origin: string): string {
  const lines: string[] = [
    "# 学习进度导出",
    "",
    `> 学员：${userName}`,
    `> 导出时间：${formatDateTime(Math.floor(Date.now() / 1000))}`,
    `> 任务数量：${tasks.length}`,
    "",
  ];

  for (const task of tasks) {
    const progress = task.progress;
    const taskFiles = fileBlock(task.task_files, origin, task.description);
    const reviewFiles = fileBlock(task.review_files, origin);
    lines.push(
      "---",
      "",
      `## 任务：${task.title}`,
      "",
      `- 状态：${progress ? (PROGRESS_LABEL[progress.status] ?? progress.status) : "未开始"}`,
      `- 进度：${progress?.percent ?? 0}%`,
      `- 技术标签：${task.tech_tags || "—"}`,
      `- 截止日期：${task.due_date ?? "不限期"}`,
      `- 审核方式：${task.require_review ? "需要辅导员审核" : "无需审核"}`,
      `- 评分：${scoreText(progress?.score ?? null)}`,
      `- 提交时间：${formatDateTime(progress?.submitted_at)}`,
      `- 审核时间：${formatDateTime(progress?.reviewed_at)}`,
      "",
      "### 任务说明",
      "",
      block(task.description),
      ...(taskFiles ? ["", "### 任务说明附件", "", taskFiles] : []),
      "",
      "### 学习步骤",
      "",
      stepSection(task.steps),
      "",
      "### 学习笔记 / 遇到的问题",
      "",
      block(progress?.note),
      "",
      "### 作品 / 代码链接",
      "",
      progress?.link ? `[${progress.link}](${progress.link})` : "（未填写）",
      "",
      "### 辅导员评语",
      "",
      block(progress?.review_comment),
      ...(reviewFiles ? ["", "### 辅导员批注附件", "", reviewFiles] : []),
      "",
      "### 作品附件",
      "",
      fileBlock(task.files, origin) || "（暂无附件）",
      "",
      "### 学习日志",
      "",
      logSection(task.logs, origin),
      "",
    );
  }

  return lines.join("\n");
}

export function buildAdminMarkdown(adminName: string, tasks: AdminExportTask[], scopeLabel: string, origin: string): string {
  const lines: string[] = [
    "# 学习进度导出（管理端）",
    "",
    `> 导出人：${adminName}`,
    `> 导出范围：${scopeLabel}`,
    `> 导出时间：${formatDateTime(Math.floor(Date.now() / 1000))}`,
    `> 任务数量：${tasks.length}`,
    "",
  ];

  for (const task of tasks) {
    const approved = task.rows.filter((row) => row.status === "approved").length;
    const taskFiles = fileBlock(task.taskFiles, origin, task.description);
    lines.push(
      "---",
      "",
      `## 任务：${task.title}`,
      "",
      `- 发布状态：${TASK_LABEL[task.status] ?? task.status}`,
      `- 发布范围：${task.class_names || "全部学员"}`,
      `- 技术标签：${task.tech_tags || "—"}`,
      `- 截止日期：${task.due_date ?? "不限期"}`,
      `- 审核方式：${task.require_review ? "需要辅导员审核" : "无需审核"}`,
      `- 应交人数：${task.rows.length}`,
      `- 已完成：${approved}`,
      "",
      "### 任务说明",
      "",
      block(task.description),
      ...(taskFiles ? ["", "### 任务说明附件", "", taskFiles] : []),
      "",
      "### 学习步骤",
      "",
      stepSection(task.steps),
      "",
      "### 学员进度",
      "",
    );

    if (!task.rows.length) {
      lines.push("（暂无应完成学员）", "");
      continue;
    }

    for (const row of task.rows) {
      const reviewFiles = fileBlock(row.review_files, origin);
      lines.push(
        `#### ${row.name}（${row.username}）${row.class_name ? ` · ${row.class_name}` : ""}`,
        "",
        `- 状态：${row.status ? (PROGRESS_LABEL[row.status] ?? row.status) : "未开始"}`,
        `- 进度：${row.percent}%`,
        `- 评分：${scoreText(row.score)}`,
        `- 提交时间：${formatDateTime(row.submitted_at)}`,
        `- 审核时间：${formatDateTime(row.reviewed_at)}`,
        `- 作品链接：${row.link ? `[${row.link}](${row.link})` : "（未填写）"}`,
        "",
        "**学习笔记：**",
        "",
        block(row.note),
        "",
        "**辅导员评语：**",
        "",
        block(row.review_comment),
        ...(reviewFiles ? ["", "**辅导员批注附件：**", "", reviewFiles] : []),
        "",
        "**作品附件：**",
        "",
        fileBlock(row.files, origin) || "（暂无附件）",
        "",
        "**学习日志：**",
        "",
        logSection(row.logs, origin),
        "",
      );
    }
  }

  return lines.join("\n");
}

export function buildShareMarkdown(
  userName: string,
  shares: ShareExportItem[],
  origin: string,
  mode: "admin" | "student" = "student",
): string {
  const lines: string[] = [
    "# 分享资料导出",
    "",
    `> 导出人：${userName}`,
    `> 导出时间：${formatDateTime(Math.floor(Date.now() / 1000))}`,
    `> 资料数量：${shares.length}`,
    "",
  ];

  for (const share of shares) {
    const files = fileBlock(share.files, origin, share.description);
    const meta = [
      `- 发布人：${share.creator_name || "辅导员"}`,
      `- 发布时间：${formatDateTime(share.created_at)}`,
      `- 最近更新：${formatDateTime(share.updated_at)}`,
      ...(mode === "admin"
        ? [
            `- 状态：${(TASK_LABEL as Record<string, string>)[share.status ?? ""] ?? share.status ?? "—"}`,
            `- 可见范围：${share.class_names || (share.audience_all === 0 ? "指定班级" : "全部学员")}`,
          ]
        : []),
      `- 技术标签：${share.tech_tags || "—"}`,
      `- 访问量：${share.view_count ?? 0} 次`,
      `- 附件数：${share.files.length} 个`,
    ];

    lines.push(
      "---",
      "",
      `## 资料：${share.title}`,
      "",
      ...meta,
      "",
      "### 资料内容",
      "",
      block(share.description),
      ...(files ? ["", "### 附件", "", files] : []),
      "",
    );
  }

  return lines.join("\n");
}
