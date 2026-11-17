import { Hono } from "hono";
import type { AppEnv } from "../types";
import { requireAuth, requireStudent } from "../lib/session";
import { HttpError, dateStr, int, str, url } from "../lib/validate";
import { bindLogFiles, bindReplyFiles, deleteStoredObjects, detachLogFiles, fileKeysForLog } from "../lib/storage";
import { STUDENT_VISIBLE } from "../lib/audience";
import { buildStudentMarkdown, parseTaskIds } from "../lib/markdown";
import { packageExport, exportFileBase, type ExportAttachment } from "../lib/export";

export const studentRoutes = new Hono<AppEnv>();
studentRoutes.use("*", requireAuth, requireStudent);

const VISIBLE = STUDENT_VISIBLE;

const LOG_PAGE_DEFAULT = 10;
const LOG_PAGE_MAX = 50;

// 列表只返回日志正文与两个轻量标记，留言与附件按需再取，避免一次加载整段历史
const LOG_COLUMNS = `SELECT
  l.id, l.minutes, l.content, l.log_date, l.created_at, l.task_id, t.title AS task_title,
  CASE WHEN NOT EXISTS (SELECT 1 FROM log_replies r WHERE r.log_id = l.id)
         AND NOT EXISTS (SELECT 1 FROM files f WHERE f.log_id = l.id AND f.uploader_id <> l.user_id AND f.reply_id IS NULL)
         AND NOT EXISTS (SELECT 1 FROM study_logs n WHERE n.user_id = l.user_id AND n.id > l.id)
       THEN 1 ELSE 0 END AS editable,
  EXISTS (SELECT 1 FROM log_replies r WHERE r.log_id = l.id) AS has_replies`;

const LOG_FROM = "FROM study_logs l LEFT JOIN tasks t ON t.id = l.task_id";

type TaskRow = { id: number; require_review: number; step_count: number };
type ProgressRow = { status: string; percent: number };
type LogRow = { id: number; log_date: string; editable: number; has_replies: number; [key: string]: unknown };

type LeaderboardRow = {
  id: number;
  name: string;
  avatar_id: string | null;
  status: string | null;
  percent: number;
  submitted_at: number | null;
  updated_at: number | null;
  reviewed_at: number | null;
};

// 已完成 > 待审核 > 学习中 / 需修改（按进度） > 未开始
const LEADERBOARD_STATUS_RANK: Record<string, number> = { approved: 0, submitted: 1, doing: 2, rejected: 2 };

function compareLeaderboardRows(a: LeaderboardRow, b: LeaderboardRow) {
  const statusRank = (row: LeaderboardRow) => (row.status ? (LEADERBOARD_STATUS_RANK[row.status] ?? 4) : 4);
  const byStatus = statusRank(a) - statusRank(b);
  if (byStatus) return byStatus;

  if (a.status === "approved") {
    const byReviewed = (a.reviewed_at ?? a.submitted_at ?? a.updated_at ?? 0) - (b.reviewed_at ?? b.submitted_at ?? b.updated_at ?? 0);
    if (byReviewed) return byReviewed;
  } else if (a.status === "submitted") {
    const bySubmitted = (a.submitted_at ?? a.updated_at ?? 0) - (b.submitted_at ?? b.updated_at ?? 0);
    if (bySubmitted) return bySubmitted;
  } else {
    const byPercent = b.percent - a.percent;
    if (byPercent) return byPercent;
  }
  return a.id - b.id;
}

function logPageLimit(c: { req: { query: (key: string) => string | undefined } }) {
  return Math.min(LOG_PAGE_MAX, Math.max(1, int(c.req.query("limit"), "每页数量", { optional: true, min: 1 }) ?? LOG_PAGE_DEFAULT));
}

/** 游标分页：以上一页最后一条日志的 (log_date, id) 为起点，避免 OFFSET 扫描 */
function logPageCursor(c: { req: { query: (key: string) => string | undefined } }) {
  const beforeDate = dateStr(c.req.query("before_date"), "分页游标");
  const beforeId = int(c.req.query("before_id"), "分页游标", { optional: true, min: 1 });
  return { beforeDate, beforeId: beforeDate ? beforeId : null };
}

function sortLogsDesc<T extends { log_date: string; id: number }>(rows: T[]) {
  return rows.sort((a, b) => (a.log_date === b.log_date ? b.id - a.id : a.log_date < b.log_date ? 1 : -1));
}

/** 只为当前页的日志取附件元数据，数量由每页条数决定，不随历史增长 */
async function withLogFiles(env: AppEnv["Bindings"], rows: LogRow[]) {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const { results } = await env.DB.prepare(
    `SELECT f.id, f.log_id, f.name, f.mime, f.size, f.created_at
       FROM files f
      WHERE f.reply_id IS NULL AND f.log_id IN (${ids.map(() => "?").join(", ")})
      ORDER BY f.created_at, f.id`,
  )
    .bind(...ids)
    .all();
  const byLog = groupBy(results as Record<string, unknown>[], "log_id");
  return rows.map((row) => ({
    ...row,
    editable: !!row.editable,
    has_replies: !!row.has_replies,
    files: byLog.get(row.id) ?? [],
  }));
}

function groupBy<T extends Record<string, unknown>>(rows: T[], key: keyof T): Map<unknown, T[]> {
  const map = new Map<unknown, T[]>();
  for (const row of rows) {
    const k = row[key];
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}

async function loadVisibleTask(c: { env: AppEnv["Bindings"] }, taskId: number, user: { id: number; class_id: number | null }) {
  const task = await c.env.DB.prepare(
    `SELECT t.id, t.require_review, (SELECT COUNT(*) FROM task_steps s WHERE s.task_id = t.id) AS step_count
       FROM tasks t WHERE t.id = ?3 AND ${VISIBLE}`,
  )
    .bind(user.id, user.class_id, taskId)
    .first<TaskRow>();
  if (!task) throw new HttpError(404, "任务不存在或未发布");
  return task;
}

type TaskContext = TaskRow & { checked: number; step_ok: number; progress: ProgressRow | null };

// 一次往返取回任务、步骤勾选数与当前进度，减少写操作前的串行查询
async function loadTaskContext(
  c: { env: AppEnv["Bindings"] },
  taskId: number,
  user: { id: number; class_id: number | null },
  stepId = 0,
): Promise<TaskContext> {
  const db = c.env.DB;
  const [taskRes, progressRes] = await db.batch([
    db.prepare(
      `SELECT t.id, t.require_review,
              (SELECT COUNT(*) FROM task_steps s WHERE s.task_id = t.id) AS step_count,
              (SELECT COUNT(*) FROM step_checks sc WHERE sc.task_id = t.id AND sc.user_id = ?1) AS checked,
              EXISTS (SELECT 1 FROM task_steps s WHERE s.id = ?4 AND s.task_id = t.id) AS step_ok
         FROM tasks t
        WHERE t.id = ?2 AND t.status = 'published'
          AND (
            NOT EXISTS (SELECT 1 FROM task_classes tc WHERE tc.task_id = t.id)
            OR EXISTS (SELECT 1 FROM task_classes tc WHERE tc.task_id = t.id AND tc.class_id = ?3)
          )
          AND NOT EXISTS (SELECT 1 FROM task_exclusions te WHERE te.task_id = t.id AND te.user_id = ?1)`,
    ).bind(user.id, taskId, user.class_id, stepId),
    db.prepare("SELECT status, percent FROM progress WHERE task_id = ? AND user_id = ?").bind(taskId, user.id),
  ]);
  const task = taskRes.results[0] as (TaskRow & { checked: number; step_ok: number }) | undefined;
  if (!task) throw new HttpError(404, "任务不存在或未发布");
  return { ...task, progress: (progressRes.results[0] as ProgressRow | undefined) ?? null };
}

function assertEditable(p: ProgressRow | null) {
  if (p && (p.status === "submitted" || p.status === "approved")) {
    throw new HttpError(409, p.status === "approved" ? "任务已完成，无法修改" : "已提交审核，如需修改请先撤回");
  }
}

/** 学习日志在辅导员留言 / 批注附件或产生更新日志后锁定，管理员仍可修改 */
function assertLogEditable(log: { has_reply: number; has_annotation: number; has_newer: number }) {
  if (log.has_reply) throw new HttpError(409, "辅导员已留言，这条日志不能再修改");
  if (log.has_annotation) throw new HttpError(409, "辅导员已添加批注附件，这条日志不能再修改");
  if (log.has_newer) throw new HttpError(409, "已有更新的学习日志，以往的日志不能再修改");
}

studentRoutes.get("/tasks", async (c) => {
  const user = c.get("user");
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.title, t.tech_tags, t.due_date, t.require_review, t.priority, t.pinned, t.pinned_at, t.created_at,
            (SELECT COUNT(*) FROM task_steps s WHERE s.task_id = t.id) AS step_count,
            (SELECT ue.due_at FROM task_urges ue
              WHERE ue.task_id = t.id AND ue.user_id = ?1
              ORDER BY ue.due_at DESC, ue.id DESC LIMIT 1) AS urge_due_at,
            (SELECT ue.message FROM task_urges ue
              WHERE ue.task_id = t.id AND ue.user_id = ?1
              ORDER BY ue.due_at DESC, ue.id DESC LIMIT 1) AS urge_message,
            (SELECT u.name FROM users u WHERE u.id = t.created_by) AS creator_name,
            p.status, COALESCE(p.percent, 0) AS percent, p.updated_at, p.review_comment, p.score
       FROM tasks t
       LEFT JOIN progress p ON p.task_id = t.id AND p.user_id = ?1
      WHERE ${VISIBLE}
      ORDER BY t.pinned DESC,
               t.pinned_at DESC,
               t.priority DESC,
               CASE WHEN p.status = 'approved' THEN 1 ELSE 0 END,
               t.due_date IS NULL, t.due_date, t.id DESC`,
  )
    .bind(user.id, user.class_id)
    .all();
  return c.json({ tasks: results });
});

studentRoutes.get("/tasks/:id", async (c) => {
  const user = c.get("user");
  const id = int(c.req.param("id"), "任务ID")!;
  const [taskRes, stepsRes, progressRes, eventsRes, filesRes, taskFilesRes, reviewFilesRes] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT t.id, t.title, t.description, t.tech_tags, t.due_date, t.require_review, t.priority, t.pinned, t.created_at,
              (SELECT u.name FROM users u WHERE u.id = t.created_by) AS creator_name,
              (SELECT a.id FROM avatars a WHERE a.user_id = t.created_by) AS creator_avatar_id,
              (SELECT ue.due_at FROM task_urges ue
                WHERE ue.task_id = t.id AND ue.user_id = ?1
                ORDER BY ue.due_at DESC, ue.id DESC LIMIT 1) AS urge_due_at,
              (SELECT ue.message FROM task_urges ue
                WHERE ue.task_id = t.id AND ue.user_id = ?1
                ORDER BY ue.due_at DESC, ue.id DESC LIMIT 1) AS urge_message
         FROM tasks t WHERE t.id = ?3 AND ${VISIBLE}`,
    ).bind(user.id, user.class_id, id),
    c.env.DB.prepare(
      `SELECT s.id, s.title, s.position, (sc.step_id IS NOT NULL) AS done
         FROM task_steps s
         LEFT JOIN step_checks sc ON sc.step_id = s.id AND sc.user_id = ?
        WHERE s.task_id = ? ORDER BY s.position, s.id`,
    ).bind(user.id, id),
    c.env.DB.prepare(
      `SELECT p.*, r.name AS reviewer_name,
              (SELECT a.id FROM avatars a WHERE a.user_id = p.reviewer_id) AS reviewer_avatar_id
         FROM progress p LEFT JOIN users r ON r.id = p.reviewer_id
        WHERE p.task_id = ? AND p.user_id = ?`,
    ).bind(id, user.id),
    c.env.DB.prepare(
      `SELECT e.id, e.action, e.comment, e.score, e.created_at, a.name AS actor_name,
              (SELECT av.id FROM avatars av WHERE av.user_id = e.actor_id) AS actor_avatar_id
         FROM progress_events e LEFT JOIN users a ON a.id = e.actor_id
        WHERE e.task_id = ? AND e.user_id = ? ORDER BY e.id DESC LIMIT 50`,
    ).bind(id, user.id),
    c.env.DB.prepare(
      `SELECT id, name, mime, size, created_at FROM files
        WHERE scope = 'progress' AND task_id = ? AND owner_user_id = ? ORDER BY created_at, id`,
    ).bind(id, user.id),
    c.env.DB.prepare(
      `SELECT id, name, mime, size, created_at FROM files
        WHERE scope = 'task' AND task_id = ? ORDER BY created_at, id`,
    ).bind(id),
    c.env.DB.prepare(
      `SELECT id, name, mime, size, created_at FROM files
        WHERE scope = 'review' AND task_id = ? AND owner_user_id = ? AND review_event_id IS NOT NULL
        ORDER BY created_at, id`,
    ).bind(id, user.id),
  ]);
  const task = taskRes.results[0];
  if (!task) throw new HttpError(404, "任务不存在或未发布");
  return c.json({
    task,
    steps: stepsRes.results.map((s: any) => ({ ...s, done: !!s.done })),
    progress: progressRes.results[0] ?? null,
    files: filesRes.results,
    task_files: taskFilesRes.results,
    review_files: reviewFilesRes.results,
    events: eventsRes.results,
  });
});

/** 当前任务的学习之星：同班学员按完成状态与进度排序，返回前 10 名与自己的名次 */
studentRoutes.get("/tasks/:id/leaderboard", async (c) => {
  const user = c.get("user");
  const taskId = int(c.req.param("id"), "任务ID")!;
  await loadVisibleTask(c, taskId, user);

  // 未分班时没有“同班”范围，返回空榜单，页面会提示先加入班级
  if (user.class_id == null) {
    return c.json({ class_name: null, total: 0, top: [], me: null });
  }

  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.name,
            (SELECT a.id FROM avatars a WHERE a.user_id = u.id) AS avatar_id,
            p.status, COALESCE(p.percent, 0) AS percent,
            p.submitted_at, p.updated_at, p.reviewed_at
       FROM users u
       LEFT JOIN progress p ON p.task_id = ?2 AND p.user_id = u.id
      WHERE u.role = 'student' AND u.active = 1 AND u.class_id = ?1
        AND NOT EXISTS (SELECT 1 FROM task_exclusions te WHERE te.task_id = ?2 AND te.user_id = u.id)`,
  )
    .bind(user.class_id, taskId)
    .all<LeaderboardRow>();

  const ranked = (results as LeaderboardRow[]).sort(compareLeaderboardRows).map((row, index) => ({
    id: row.id,
    name: row.name,
    avatar_id: row.avatar_id,
    status: row.status,
    percent: row.percent,
    rank: index + 1,
    is_me: row.id === user.id,
  }));

  return c.json({
    class_name: user.class_name,
    total: ranked.length,
    top: ranked.slice(0, 10),
    me: ranked.find((row) => row.id === user.id) ?? null,
  });
});

/** 某个任务下的学习日志：倒序 + 游标分页，默认 10 条，留言按需单独加载 */
studentRoutes.get("/tasks/:id/logs", async (c) => {
  const user = c.get("user");
  const taskId = int(c.req.param("id"), "任务ID")!;
  await loadVisibleTask(c, taskId, user);

  const limit = logPageLimit(c);
  const { beforeDate, beforeId } = logPageCursor(c);
  const focusId = int(c.req.query("log"), "日志ID", { optional: true, min: 1 }) ?? 0;

  function pageStmt(extra: string, extraBinds: (string | number)[]) {
    const conds = ["l.user_id = ?", "l.task_id = ?", extra].filter(Boolean);
    const binds = [user.id, taskId, ...extraBinds, limit + 1];
    return c.env.DB.prepare(`${LOG_COLUMNS} ${LOG_FROM} WHERE ${conds.join(" AND ")} ORDER BY l.log_date DESC, l.id DESC LIMIT ?`).bind(...binds);
  }

  const cursorWhere = beforeDate && beforeId ? "(l.log_date < ? OR (l.log_date = ? AND l.id < ?))" : "";
  const cursorBinds = cursorWhere ? [beforeDate!, beforeDate!, beforeId!] : [];
  const statements = [pageStmt(cursorWhere, cursorBinds)];
  if (focusId) statements.push(c.env.DB.prepare(`${LOG_COLUMNS} ${LOG_FROM} WHERE l.user_id = ? AND l.task_id = ? AND l.id = ?`).bind(user.id, taskId, focusId));
  const results = await c.env.DB.batch(statements);

  const rows = results[0].results as LogRow[];
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const focusRow = focusId ? (results[1].results[0] as LogRow | undefined) : undefined;
  const merged = focusRow && !pageRows.some((row) => row.id === focusRow.id) ? [...pageRows, focusRow] : pageRows;
  const last = pageRows[pageRows.length - 1];
  return c.json({
    logs: await withLogFiles(c.env, sortLogsDesc(merged)),
    has_more: hasMore,
    next: hasMore && last ? { log_date: last.log_date, id: last.id } : null,
  });
});

studentRoutes.put("/tasks/:id/steps/:stepId", async (c) => {
  const user = c.get("user");
  const taskId = int(c.req.param("id"), "任务ID")!;
  const stepId = int(c.req.param("stepId"), "步骤ID")!;
  const { done } = await c.req.json<{ done: boolean }>();
  const task = await loadTaskContext(c, taskId, user, stepId);
  if (!task.step_ok) throw new HttpError(404, "步骤不存在");
  assertEditable(task.progress);

  const toggle = done
    ? c.env.DB.prepare("INSERT OR IGNORE INTO step_checks (user_id, step_id, task_id) VALUES (?, ?, ?)").bind(user.id, stepId, taskId)
    : c.env.DB.prepare("DELETE FROM step_checks WHERE user_id = ? AND step_id = ?").bind(user.id, stepId);

  const results = await c.env.DB.batch([
    toggle,
    c.env.DB.prepare(
      `INSERT INTO progress (task_id, user_id, status, percent, updated_at)
       VALUES (?1, ?2, 'doing', (SELECT CAST(COUNT(*) * 100 / CAST(?3 AS INTEGER) AS INTEGER) FROM step_checks WHERE task_id = ?1 AND user_id = ?2), unixepoch())
       ON CONFLICT (task_id, user_id) DO UPDATE SET
         status = CASE WHEN status = 'rejected' THEN 'rejected' ELSE 'doing' END,
         percent = excluded.percent, updated_at = unixepoch()
       RETURNING status, percent`,
    ).bind(taskId, user.id, task.step_count || 1),
  ]);
  return c.json({ progress: results[1].results[0] });
});

studentRoutes.put("/tasks/:id/progress", async (c) => {
  const user = c.get("user");
  const taskId = int(c.req.param("id"), "任务ID")!;
  const body = await c.req.json();
  const task = await loadTaskContext(c, taskId, user);
  assertEditable(task.progress);

  const note = str(body.note, "学习笔记", { optional: true, max: 2000 });
  const link = url(body.link);
  const manualPercent = task.step_count === 0 ? int(body.percent, "进度", { min: 0, max: 100, optional: true }) : null;

  const row = await c.env.DB.prepare(
    `INSERT INTO progress (task_id, user_id, status, percent, note, link, updated_at)
     VALUES (?1, ?2, 'doing', COALESCE(?3, 0), ?4, ?5, unixepoch())
     ON CONFLICT (task_id, user_id) DO UPDATE SET
       percent = COALESCE(?3, percent), note = ?4, link = ?5, updated_at = unixepoch()
     RETURNING *`,
  )
    .bind(taskId, user.id, manualPercent, note, link)
    .first();
  return c.json({ progress: row });
});

studentRoutes.post("/tasks/:id/submit", async (c) => {
  const user = c.get("user");
  const taskId = int(c.req.param("id"), "任务ID")!;
  const task = await loadTaskContext(c, taskId, user);
  assertEditable(task.progress);
  if (task.checked < task.step_count) throw new HttpError(400, "请先完成所有学习步骤再提交");

  const status = task.require_review ? "submitted" : "approved";
  const row = await c.env.DB.prepare(
    `INSERT INTO progress (task_id, user_id, status, percent, submitted_at, reviewed_at, updated_at)
     VALUES (?1, ?2, ?3, 100, unixepoch(), CASE WHEN ?3 = 'approved' THEN unixepoch() END, unixepoch())
     ON CONFLICT (task_id, user_id) DO UPDATE SET
       status = ?3, percent = 100, score = NULL, reviewer_id = NULL, review_comment = '', submitted_at = unixepoch(),
       reviewed_at = CASE WHEN ?3 = 'approved' THEN unixepoch() ELSE NULL END,
       updated_at = unixepoch()
     RETURNING *`,
  )
    .bind(taskId, user.id, status)
    .first();
  return c.json({ progress: row });
});

studentRoutes.post("/tasks/:id/withdraw", async (c) => {
  const user = c.get("user");
  const taskId = int(c.req.param("id"), "任务ID")!;
  const row = await c.env.DB.prepare(
    `UPDATE progress SET status = 'doing', submitted_at = NULL, updated_at = unixepoch()
      WHERE task_id = ? AND user_id = ? AND status = 'submitted' RETURNING *`,
  )
    .bind(taskId, user.id)
    .first();
  if (!row) throw new HttpError(409, "当前状态无法撤回");
  return c.json({ progress: row });
});

/** 导出当前学员的学习进度为 Markdown，可一次选择多个任务 */
studentRoutes.get("/export", async (c) => {
  const user = c.get("user");
  const origin = new URL(c.req.url).origin;
  const ids = parseTaskIds(c.req.query("task_ids"));
  const idFilter = ids.length ? ` AND t.id IN (${ids.map((_, i) => `?${i + 3}`).join(", ")})` : "";
  const { results: tasks } = await c.env.DB.prepare(
    `SELECT t.id, t.title, t.description, t.tech_tags, t.due_date, t.require_review
       FROM tasks t
      WHERE ${VISIBLE}${idFilter}
      ORDER BY CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END, t.due_date, t.id DESC`,
  )
    .bind(user.id, user.class_id, ...ids)
    .all<{
      id: number;
      title: string;
      description: string;
      tech_tags: string;
      due_date: string | null;
      require_review: number;
    }>();

  const taskIds = tasks.map((task) => task.id);
  if (!taskIds.length) {
    const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const base = exportFileBase("学迹学习任务", [], stamp, "全部任务", "个任务");
    const mdName = `${base}.md`;
    const zip = await packageExport(c.env, buildStudentMarkdown(user.name, [], origin), mdName, []);
    return c.body(zip, 200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="study-trail-${stamp}.zip"; filename*=UTF-8''${encodeURIComponent(`${base}.zip`)}`,
      "Content-Length": String(zip.byteLength),
    });
  }

  const inTasks = taskIds.map(() => "?").join(", ");
  const [stepsRes, progressRes, filesRes, taskFilesRes, reviewFilesRes, logsRes, logFilesRes, repliesRes, replyFilesRes] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT s.task_id, s.title, (sc.step_id IS NOT NULL) AS done
         FROM task_steps s
         LEFT JOIN step_checks sc ON sc.step_id = s.id AND sc.user_id = ?
        WHERE s.task_id IN (${inTasks}) ORDER BY s.task_id, s.position, s.id`,
    ).bind(user.id, ...taskIds),
    c.env.DB.prepare(`SELECT * FROM progress WHERE user_id = ? AND task_id IN (${inTasks})`).bind(user.id, ...taskIds),
    c.env.DB.prepare(
      `SELECT id, task_id, name, mime, size FROM files
        WHERE scope = 'progress' AND owner_user_id = ? AND task_id IN (${inTasks})
        ORDER BY created_at, id`,
    ).bind(user.id, ...taskIds),
    c.env.DB.prepare(
      `SELECT id, task_id, name, mime, size FROM files
        WHERE scope = 'task' AND task_id IN (${inTasks}) ORDER BY created_at, id`,
    ).bind(...taskIds),
    c.env.DB.prepare(
      `SELECT id, task_id, name, mime, size FROM files
        WHERE scope = 'review' AND owner_user_id = ? AND task_id IN (${inTasks}) AND review_event_id IS NOT NULL
        ORDER BY created_at, id`,
    ).bind(user.id, ...taskIds),
    c.env.DB.prepare(
      `SELECT id, task_id, minutes, content, log_date FROM study_logs
        WHERE user_id = ? AND task_id IN (${inTasks})
        ORDER BY log_date DESC, id DESC`,
    ).bind(user.id, ...taskIds),
    c.env.DB.prepare(
      `SELECT f.id, f.log_id, f.name, f.mime, f.size
         FROM files f JOIN study_logs l ON l.id = f.log_id
        WHERE l.user_id = ? AND l.task_id IN (${inTasks}) AND f.reply_id IS NULL ORDER BY f.created_at, f.id`,
    ).bind(user.id, ...taskIds),
    c.env.DB.prepare(
      `SELECT r.id, r.log_id, r.parent_id, r.content, r.created_at, r.user_id, u.name AS author_name, u.role AS author_role,
              (SELECT a.id FROM avatars a WHERE a.user_id = r.user_id) AS author_avatar_id
         FROM log_replies r JOIN users u ON u.id = r.user_id JOIN study_logs l ON l.id = r.log_id
        WHERE l.user_id = ? AND l.task_id IN (${inTasks}) ORDER BY r.id`,
    ).bind(user.id, ...taskIds),
    c.env.DB.prepare(
      `SELECT f.id, f.reply_id, f.name, f.mime, f.size
         FROM files f JOIN study_logs l ON l.id = f.log_id
        WHERE l.user_id = ? AND l.task_id IN (${inTasks}) AND f.scope = 'reply' ORDER BY f.created_at, f.id`,
    ).bind(user.id, ...taskIds),
  ]);

  const exportFiles: ExportAttachment[] = [
    ...(taskFilesRes.results as any[]),
    ...(filesRes.results as any[]),
    ...(reviewFilesRes.results as any[]),
    ...(logFilesRes.results as any[]),
    ...(replyFilesRes.results as any[]),
  ].map((file) => ({ id: String(file.id), name: String(file.name) }));

  const stepMap = groupBy(stepsRes.results as Record<string, unknown>[], "task_id");
  const progressMap = new Map((progressRes.results as any[]).map((row) => [row.task_id, row]));
  const fileMap = groupBy(filesRes.results as Record<string, unknown>[], "task_id");
  const taskFileMap = groupBy(taskFilesRes.results as Record<string, unknown>[], "task_id");
  const reviewFileMap = groupBy(reviewFilesRes.results as Record<string, unknown>[], "task_id");
  const logMap = groupBy(logsRes.results as Record<string, unknown>[], "task_id");
  const logFileMap = groupBy(logFilesRes.results as Record<string, unknown>[], "log_id");
  const replyMap = groupBy(repliesRes.results as Record<string, unknown>[], "log_id");
  const replyFileMap = groupBy(replyFilesRes.results as Record<string, unknown>[], "reply_id");

  const md = buildStudentMarkdown(
    user.name,
    tasks.map((task) => ({
      ...task,
      steps: (stepMap.get(task.id) ?? []).map((step: any) => ({ title: step.title, done: !!step.done })),
      progress: (progressMap.get(task.id) as any) ?? null,
      files: (fileMap.get(task.id) ?? []) as any,
      task_files: (taskFileMap.get(task.id) ?? []) as any,
      review_files: (reviewFileMap.get(task.id) ?? []) as any,
      logs: (logMap.get(task.id) ?? []).map((log: any) => ({
        ...log,
        files: (logFileMap.get(log.id) ?? []) as any,
        replies: ((replyMap.get(log.id) ?? []) as any[]).map((reply) => ({
          ...reply,
          files: replyFileMap.get(reply.id) ?? [],
        })),
      })),
    })),
    origin,
  );

  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const base = exportFileBase("学迹学习任务", tasks.map((task) => task.title), stamp, "全部任务", "个任务");
  const mdName = `${base}.md`;
  const zip = await packageExport(c.env, md, mdName, exportFiles);
  return c.body(zip, 200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="study-trail-${stamp}.zip"; filename*=UTF-8''${encodeURIComponent(`${base}.zip`)}`,
    "Content-Length": String(zip.byteLength),
  });
});

studentRoutes.get("/logs", async (c) => {
  const user = c.get("user");
  const limit = logPageLimit(c);
  const { beforeDate, beforeId } = logPageCursor(c);
  const focusId = int(c.req.query("log"), "日志ID", { optional: true, min: 1 }) ?? 0;
  const taskParam = c.req.query("task_id");
  const taskFilter = taskParam === "none" ? "none" : taskParam ? int(taskParam, "任务", { min: 1 }) : null;

  const conds = ["l.user_id = ?"];
  const binds: (string | number)[] = [user.id];
  if (taskFilter === "none") conds.push("l.task_id IS NULL");
  else if (typeof taskFilter === "number") {
    conds.push("l.task_id = ?");
    binds.push(taskFilter);
  }
  if (beforeDate && beforeId) {
    conds.push("(l.log_date < ? OR (l.log_date = ? AND l.id < ?))");
    binds.push(beforeDate, beforeDate, beforeId);
  }

  const statements = [
    c.env.DB.prepare(`${LOG_COLUMNS} ${LOG_FROM} WHERE ${conds.join(" AND ")} ORDER BY l.log_date DESC, l.id DESC LIMIT ?`).bind(
      ...binds,
      limit + 1,
    ),
    c.env.DB.prepare(
      `SELECT log_date, SUM(minutes) AS minutes, COUNT(*) AS count
         FROM study_logs WHERE user_id = ? GROUP BY log_date ORDER BY log_date DESC LIMIT 90`,
    ).bind(user.id),
  ];
  // 通知里的 ?log= 可能指向很早的日志：单独取一条，避免把整页游标打乱
  if (focusId) {
    statements.push(c.env.DB.prepare(`${LOG_COLUMNS} ${LOG_FROM} WHERE l.user_id = ? AND l.id = ?`).bind(user.id, focusId));
  }
  // 任务筛选项只在日志页需要时计算一次，用于显示各任务的日志条数
  const wantFacets = !beforeDate && c.req.query("with_facets") === "1";
  if (wantFacets) {
    statements.push(
      c.env.DB.prepare(
        `SELECT l.task_id, COUNT(*) AS count, MAX(t.title) AS title
           FROM study_logs l LEFT JOIN tasks t ON t.id = l.task_id
          WHERE l.user_id = ? GROUP BY l.task_id`,
      ).bind(user.id),
    );
  }
  const results = await c.env.DB.batch(statements);

  const rows = results[0].results as LogRow[];
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const focusRow = focusId ? (results[2].results[0] as LogRow | undefined) : undefined;
  const merged = focusRow && !pageRows.some((row) => row.id === focusRow.id) ? [...pageRows, focusRow] : pageRows;
  const last = pageRows[pageRows.length - 1];
  const facetsRow = wantFacets ? results[focusId ? 3 : 2] : undefined;

  return c.json({
    logs: await withLogFiles(c.env, sortLogsDesc(merged)),
    daily: results[1].results,
    has_more: hasMore,
    next: hasMore && last ? { log_date: last.log_date, id: last.id } : null,
    facets: (facetsRow?.results ?? []) as { task_id: number | null; count: number; title: string | null }[],
  });
});

/** 按需加载某条日志的留言与留言附件（学员端） */
studentRoutes.get("/logs/:id/replies", async (c) => {
  const user = c.get("user");
  const id = int(c.req.param("id"), "日志ID")!;
  const log = await c.env.DB.prepare("SELECT id FROM study_logs WHERE id = ? AND user_id = ?").bind(id, user.id).first<{ id: number }>();
  if (!log) throw new HttpError(404, "日志不存在");

  const [repliesRes, filesRes] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT r.id, r.log_id, r.parent_id, r.content, r.created_at, r.user_id, u.name AS author_name, u.role AS author_role,
              (SELECT a.id FROM avatars a WHERE a.user_id = r.user_id) AS author_avatar_id
         FROM log_replies r JOIN users u ON u.id = r.user_id
        WHERE r.log_id = ? ORDER BY r.id LIMIT 200`,
    ).bind(id),
    c.env.DB.prepare(
      `SELECT f.id, f.reply_id, f.name, f.mime, f.size, f.created_at
         FROM files f JOIN log_replies r ON r.id = f.reply_id
        WHERE r.log_id = ? AND f.scope = 'reply' ORDER BY f.created_at, f.id`,
    ).bind(id),
  ]);
  const replyFiles = groupBy(filesRes.results as Record<string, unknown>[], "reply_id");
  return c.json({
    replies: (repliesRes.results as any[]).map((reply) => ({
      ...reply,
      files: replyFiles.get(reply.id) ?? [],
    })),
  });
});

studentRoutes.post("/logs", async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const content = str(body.content, "学习内容", { max: 10000 });
  const minutes = int(body.minutes, "学习时长", { min: 0, max: 1440 })!;
  const logDate = dateStr(body.log_date, "日期", false)!;
  const taskId = int(body.task_id, "关联任务", { min: 1, optional: true });
  if (taskId) await loadVisibleTask(c, taskId, user);
  const row = await c.env.DB.prepare(
    "INSERT INTO study_logs (user_id, task_id, minutes, content, log_date) VALUES (?, ?, ?, ?, ?) RETURNING id",
  )
    .bind(user.id, taskId, minutes, content, logDate)
    .first<{ id: number }>();
  try {
    await bindLogFiles(c.env, user.id, row!.id, body.file_ids);
  } catch (err) {
    await c.env.DB.prepare("DELETE FROM study_logs WHERE id = ? AND user_id = ?").bind(row!.id, user.id).run();
    throw err;
  }
  return c.json({ log: row });
});

studentRoutes.patch("/logs/:id", async (c) => {
  const user = c.get("user");
  const id = int(c.req.param("id"), "日志ID")!;
  const body = await c.req.json();
  const content = str(body.content, "学习内容", { max: 10000 });
  const minutes = int(body.minutes, "学习时长", { min: 0, max: 1440 })!;
  const logDate = dateStr(body.log_date, "日期", false)!;
  const taskId = int(body.task_id, "关联任务", { min: 1, optional: true });
  const existing = await c.env.DB.prepare(
    `SELECT l.task_id,
            EXISTS (SELECT 1 FROM log_replies r WHERE r.log_id = l.id) AS has_reply,
            EXISTS (SELECT 1 FROM files f WHERE f.log_id = l.id AND f.uploader_id <> l.user_id AND f.reply_id IS NULL) AS has_annotation,
            EXISTS (SELECT 1 FROM study_logs n WHERE n.user_id = l.user_id AND n.id > l.id) AS has_newer
       FROM study_logs l WHERE l.id = ? AND l.user_id = ?`,
  )
    .bind(id, user.id)
    .first<{ task_id: number | null; has_reply: number; has_annotation: number; has_newer: number }>();
  if (!existing) throw new HttpError(404, "日志不存在");
  assertLogEditable(existing);
  if (taskId && taskId !== existing.task_id) await loadVisibleTask(c, taskId, user);
  const row = await c.env.DB.prepare(
    "UPDATE study_logs SET content = ?, minutes = ?, log_date = ?, task_id = ? WHERE id = ? AND user_id = ? RETURNING id",
  )
    .bind(content, minutes, logDate, taskId, id, user.id)
    .first();
  if (!row) throw new HttpError(404, "日志不存在");
  await detachLogFiles(c.env, user.id, id, body.remove_file_ids);
  await bindLogFiles(c.env, user.id, id, body.file_ids);
  return c.json({ log: row });
});

studentRoutes.post("/logs/:id/replies", async (c) => {
  const user = c.get("user");
  const id = int(c.req.param("id"), "日志ID")!;
  const body = await c.req.json();
  const content = str(body.content, "回复内容", { max: 2000, optional: true });
  const parentId = int(body.parent_id, "回复对象", { min: 1 })!;
  const hasFiles = Array.isArray(body.file_ids) && body.file_ids.length > 0;
  if (!content && !hasFiles) throw new HttpError(400, "回复内容不能为空");
  const log = await c.env.DB.prepare("SELECT id FROM study_logs WHERE id = ? AND user_id = ?")
    .bind(id, user.id)
    .first<{ id: number }>();
  if (!log) throw new HttpError(404, "日志不存在");
  const parent = await c.env.DB.prepare(
    `SELECT r.id FROM log_replies r JOIN users u ON u.id = r.user_id WHERE r.id = ? AND r.log_id = ? AND u.role = 'admin'`,
  )
    .bind(parentId, id)
    .first<{ id: number }>();
  if (!parent) throw new HttpError(400, "只能回复辅导员的留言");

  const row = await c.env.DB.prepare(
    "INSERT INTO log_replies (log_id, user_id, parent_id, content) VALUES (?, ?, ?, ?) RETURNING id, created_at",
  )
    .bind(id, user.id, parentId, content)
    .first<{ id: number; created_at: number }>();
  try {
    await bindReplyFiles(c.env, id, row!.id, user.id, body.file_ids);
  } catch (err) {
    await c.env.DB.prepare("DELETE FROM log_replies WHERE id = ?").bind(row!.id).run();
    throw err;
  }
  const [avatar, files] = await Promise.all([
    c.env.DB.prepare("SELECT id FROM avatars WHERE user_id = ?").bind(user.id).first<{ id: string }>(),
    c.env.DB.prepare("SELECT id, name, mime, size, created_at FROM files WHERE scope = 'reply' AND reply_id = ? ORDER BY created_at, id")
      .bind(row!.id)
      .all(),
  ]);
  return c.json({
    reply: {
      ...row!,
      log_id: id,
      parent_id: parentId,
      content,
      user_id: user.id,
      author_name: user.name,
      author_role: user.role,
      author_avatar_id: avatar?.id ?? null,
      files: files.results,
    },
  });
});

studentRoutes.delete("/logs/:id", async (c) => {
  const user = c.get("user");
  const id = int(c.req.param("id"), "日志ID")!;
  const log = await c.env.DB.prepare(
    `SELECT l.id,
            EXISTS (SELECT 1 FROM log_replies r WHERE r.log_id = l.id) AS has_reply,
            EXISTS (SELECT 1 FROM files f WHERE f.log_id = l.id AND f.uploader_id <> l.user_id AND f.reply_id IS NULL) AS has_annotation,
            EXISTS (SELECT 1 FROM study_logs n WHERE n.user_id = l.user_id AND n.id > l.id) AS has_newer
       FROM study_logs l WHERE l.id = ? AND l.user_id = ?`,
  )
    .bind(id, user.id)
    .first<{ id: number; has_reply: number; has_annotation: number; has_newer: number }>();
  if (!log) throw new HttpError(404, "日志不存在");
  assertLogEditable(log);
  const keys = await fileKeysForLog(c.env, id);
  await c.env.DB.prepare("DELETE FROM study_logs WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  await deleteStoredObjects(c.env, keys);
  return c.json({ ok: true });
});
