import { Hono } from "hono";
import type { AppEnv } from "../types";
import { requireAdmin, requireAuth, requireSuperAdmin } from "../lib/session";
import { hashPassword, randomPassword } from "../lib/crypto";
import { createZip } from "../lib/zip";
import { audit } from "../lib/audit";
import { HttpError, dateStr, int, password, str, username } from "../lib/validate";
import {
  MAX_REVIEW_FILES,
  MAX_SHARE_FILES,
  MAX_TASK_FILES,
  STORAGE_LABELS,
  availableStorageBackends,
  avatarKeysForUser,
  bindLogFiles,
  bindReplyFiles,
  bindReviewFiles,
  bindShareFiles,
  bindTaskFiles,
  deleteStoredObjects,
  detachLogFiles,
  detachShareFiles,
  detachTaskFiles,
  fileKeysForLog,
  fileKeysForTask,
  fileKeysForUser,
  normalizeFileIds,
  storageBackend,
  type StorageBackend,
} from "../lib/storage";
import { formatStorageBytes, scopeQuotaBytes, storageCapacity, studentQuotaBytes } from "../lib/quota";
import {
  audienceSql,
  audienceStatements,
  normalizeIdList,
  notifyTaskUsers,
  taskAudienceUserIds,
} from "../lib/audience";
import {
  notifyShareUsers,
  shareAudienceStatements,
  shareAudienceUserIds,
} from "../lib/share-audience";
import { buildAdminMarkdown, buildShareMarkdown, parseIdList, parseShareIds, parseTaskIds } from "../lib/markdown";
import { packageExport, exportFileBase, type ExportAttachment } from "../lib/export";

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use("*", requireAuth, requireAdmin);

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

const ELIGIBLE = `u.role = 'student' AND u.active = 1 AND ${audienceSql("t", "u")}`;

function tagList(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,，\s]+/) : [];
  const tags = [...new Set(list.map((t) => String(t).trim()).filter(Boolean))];
  if (tags.some((t) => t.length > 24)) throw new HttpError(400, "单个技术标签不能超过 24 个字符");
  return tags;
}

function normalizeTags(value: unknown): string {
  return tagList(value).slice(0, 12).join(",");
}

function normalizeSteps(value: unknown): { id?: number; title: string }[] {
  if (!Array.isArray(value)) return [];
  if (value.length > 50) throw new HttpError(400, "学习步骤最多 50 个");
  return value
    .map((s) => (typeof s === "string" ? { title: s } : { id: s?.id ? Number(s.id) : undefined, title: String(s?.title ?? "") }))
    .map((s) => ({ ...s, title: s.title.trim() }))
    .filter((s) => s.title)
    .map((s) => {
      if (s.title.length > 200) throw new HttpError(400, "步骤标题不能超过 200 个字符");
      return s;
    });
}

function siteUrl(value: unknown, fallback: string): string {
  const firstLine = typeof value === "string" ? (value.trim().split(/\s+/)[0] ?? "") : "";
  return (firstLine || fallback).slice(0, 500);
}

interface GeneratedAccount {
  username: string;
  name: string;
  password: string;
  site_url: string;
}

/** 单个账号信息文档；批量时带 [序号/总数]，单个时保持简洁 */
function accountText(account: GeneratedAccount, index: number, total: number): string {
  const header = total > 1 ? `[${index}/${total}]学迹账号` : "学迹账号";
  return `${header}\n\n网址：${account.site_url || "（未填写）"}\n用户名：${account.username}\n密码：${account.password}`;
}

/** 汇总文档 / 复制文本：多个账号之间用分隔线隔开 */
function accountsText(accounts: GeneratedAccount[]): string {
  return `${accounts.map((account, index) => accountText(account, index + 1, accounts.length)).join("\n\n——————\n\n")}\n`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/* ---------------- 概览 ---------------- */

adminRoutes.get("/overview", async (c) => {
  const db = c.env.DB;
  const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
  const monthAgo = Math.floor(Date.now() / 1000) - 30 * 86400;
  const [counts, assigned, taskStats, activity, leaders] = await db.batch([
    db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE role = 'student' AND active = 1) AS students,
         (SELECT COUNT(*) FROM tasks WHERE status = 'published') AS tasks,
         (SELECT COUNT(*) FROM progress p JOIN tasks t ON t.id = p.task_id WHERE p.status = 'submitted' AND t.status = 'published') AS pending,
         (SELECT COALESCE(SUM(minutes), 0) FROM study_logs WHERE created_at >= ?) AS week_minutes,
         (SELECT COUNT(DISTINCT user_id) FROM study_logs WHERE created_at >= ?) AS week_active`,
    ).bind(weekAgo, weekAgo),
    db.prepare(
      `SELECT COUNT(*) AS assigned, SUM(CASE WHEN p.status = 'approved' THEN 1 ELSE 0 END) AS approved
         FROM tasks t JOIN users u ON ${ELIGIBLE}
         LEFT JOIN progress p ON p.task_id = t.id AND p.user_id = u.id
        WHERE t.status = 'published'`,
    ),
    db.prepare(
      `SELECT t.id, t.title, t.due_date, COUNT(u.id) AS assigned,
              SUM(CASE WHEN p.status = 'approved' THEN 1 ELSE 0 END) AS approved,
              SUM(CASE WHEN p.status = 'submitted' THEN 1 ELSE 0 END) AS submitted,
              SUM(CASE WHEN p.status IN ('doing', 'rejected') THEN 1 ELSE 0 END) AS doing
         FROM tasks t JOIN users u ON ${ELIGIBLE}
         LEFT JOIN progress p ON p.task_id = t.id AND p.user_id = u.id
        WHERE t.status = 'published'
        GROUP BY t.id ORDER BY t.id DESC LIMIT 8`,
    ),
    db.prepare(
      `SELECT * FROM (
         SELECT 'progress' AS kind, p.updated_at AS at, u.name AS user_name, t.title AS task_title, p.status AS detail, p.percent AS extra,
                p.user_id, p.task_id, NULL AS log_id
           FROM progress p JOIN users u ON u.id = p.user_id JOIN tasks t ON t.id = p.task_id
          WHERE p.updated_at >= ?
         UNION ALL
         SELECT 'log' AS kind, l.created_at AS at, u.name, t.title, l.content, l.minutes,
                l.user_id, l.task_id, l.id AS log_id
           FROM study_logs l JOIN users u ON u.id = l.user_id LEFT JOIN tasks t ON t.id = l.task_id
          WHERE l.created_at >= ?
       ) ORDER BY at DESC LIMIT 12`,
    ).bind(weekAgo, weekAgo),
    db.prepare(
      `SELECT u.id, u.name, c.name AS class_name,
              (SELECT COUNT(*) FROM progress p JOIN tasks t ON t.id = p.task_id
                WHERE p.user_id = u.id AND p.status = 'approved' AND t.status = 'published'
                  AND ${audienceSql("t", "u")}) AS completed,
              (SELECT COALESCE(SUM(minutes), 0) FROM study_logs l WHERE l.user_id = u.id) AS minutes
         FROM users u LEFT JOIN classes c ON c.id = u.class_id
        WHERE u.role = 'student' AND u.active = 1
          AND (
            EXISTS (SELECT 1 FROM progress p WHERE p.user_id = u.id AND p.updated_at >= ?)
            OR EXISTS (SELECT 1 FROM study_logs l WHERE l.user_id = u.id AND l.created_at >= ?)
          )
        ORDER BY completed DESC, minutes DESC LIMIT 5`,
    ).bind(monthAgo, monthAgo),
  ]);
  const countRow = counts.results[0] as { students: number; tasks: number } | undefined;
  return c.json({
    counts: countRow,
    completion: assigned.results[0],
    tasks: taskStats.results,
    activity: activity.results,
    leaders: leaders.results,
    // 刚初始化或刚升级的实例没有学员/任务，提示管理员从旧备份恢复数据
    needsRestore: (countRow?.students ?? 0) === 0 && (countRow?.tasks ?? 0) === 0,
  });
});

/* ---------------- 存储用量 ---------------- */

adminRoutes.get("/storage", requireSuperAdmin, async (c) => {
  const db = c.env.DB;
  const available = availableStorageBackends(c.env);
  let backend: StorageBackend | null = available[0] ?? null;
  try {
    backend = await storageBackend(c.env);
  } catch {
    // 未绑定文件存储时仍然返回统计结果，页面会提示存储不可用
  }
  const capacity = storageCapacity(c.env, backend);

  // 合并汇总查询：files 只扫描一次，再在 Worker 内汇总总用量、类型与学员占用。
  // 相比原先的总量 / 类型 / 学员三次扫描，文件越多节省越明显。
  const [fileGroupsRes, avatarGroupsRes, studentRowsRes] = await db.batch([
    db.prepare(
      `SELECT owner_user_id, scope, SUM(size) AS bytes, COUNT(*) AS count, MAX(created_at) AS last_at
         FROM files
        GROUP BY owner_user_id, scope`,
    ),
    db.prepare(
      `SELECT user_id, SUM(size) AS bytes, COUNT(*) AS count, MAX(created_at) AS last_at
         FROM avatars
        GROUP BY user_id`,
    ),
    db.prepare(
      `SELECT u.id, u.username, u.name, u.active, u.class_id, c.name AS class_name
         FROM users u
         LEFT JOIN classes c ON c.id = u.class_id
        WHERE u.role = 'student'`,
    ),
  ]);

  type FileGroupRow = { owner_user_id: number; scope: string; bytes: number; count: number; last_at: number | null };
  type AvatarGroupRow = { user_id: number; bytes: number; count: number; last_at: number | null };
  type StudentUsageRow = {
    id: number;
    username: string;
    name: string;
    active: number;
    class_id: number | null;
    class_name: string | null;
  };

  let attachmentBytes = 0;
  let fileCount = 0;
  const scopeTotals = new Map<string, { bytes: number; count: number }>();
  const fileByOwner = new Map<number, { bytes: number; count: number; last_at: number }>();
  for (const row of fileGroupsRes.results as FileGroupRow[]) {
    const bytes = Number(row.bytes);
    const count = Number(row.count);
    attachmentBytes += bytes;
    fileCount += count;
    const scope = scopeTotals.get(row.scope) ?? { bytes: 0, count: 0 };
    scope.bytes += bytes;
    scope.count += count;
    scopeTotals.set(row.scope, scope);
    const owner = fileByOwner.get(row.owner_user_id) ?? { bytes: 0, count: 0, last_at: 0 };
    owner.bytes += bytes;
    owner.count += count;
    owner.last_at = Math.max(owner.last_at, Number(row.last_at ?? 0));
    fileByOwner.set(row.owner_user_id, owner);
  }

  let avatarBytes = 0;
  let avatarCount = 0;
  const avatarByOwner = new Map<number, { bytes: number; last_at: number }>();
  for (const row of avatarGroupsRes.results as AvatarGroupRow[]) {
    const bytes = Number(row.bytes);
    avatarBytes += bytes;
    avatarCount += Number(row.count);
    avatarByOwner.set(row.user_id, { bytes, last_at: Number(row.last_at ?? 0) });
  }

  const usedBytes = attachmentBytes + avatarBytes;
  const students = (studentRowsRes.results as StudentUsageRow[])
    .map((row) => {
      const files = fileByOwner.get(row.id);
      const avatar = avatarByOwner.get(row.id);
      const fileBytes = Number(files?.bytes ?? 0);
      const avatarBytesForUser = Number(avatar?.bytes ?? 0);
      const lastUploadAt = Math.max(Number(files?.last_at ?? 0), Number(avatar?.last_at ?? 0)) || null;
      return {
        id: row.id,
        username: row.username,
        name: row.name,
        active: row.active,
        class_id: row.class_id ?? null,
        class_name: row.class_name,
        file_bytes: fileBytes,
        file_count: Number(files?.count ?? 0),
        avatar_bytes: avatarBytesForUser,
        total_bytes: fileBytes + avatarBytesForUser,
        last_upload_at: lastUploadAt,
      };
    })
    .sort((a, b) => b.total_bytes - a.total_bytes || a.name.localeCompare(b.name, "zh-CN"));

  return c.json({
    storage: {
      backend,
      label: backend ? STORAGE_LABELS[backend] : "未绑定文件存储",
      available,
      total_bytes: capacity.bytes,
      total_source: capacity.source,
      used_bytes: usedBytes,
      free_bytes: Math.max(0, capacity.bytes - usedBytes),
      percent: capacity.bytes > 0 ? (usedBytes / capacity.bytes) * 100 : 0,
      attachment_bytes: attachmentBytes,
      avatar_bytes: avatarBytes,
      file_count: fileCount,
      avatar_count: avatarCount,
      scope_quota_bytes: scopeQuotaBytes(c.env),
      student_quota_bytes: studentQuotaBytes(c.env),
    },
    scopes: [...scopeTotals.entries()].map(([scope, value]) => ({
      scope,
      bytes: value.bytes,
      count: value.count,
    })),
    students,
    generated_at: Date.now(),
  });
});

/* ---------------- 文件明细 ---------------- */

const STORAGE_FILE_SCOPES = ["log", "progress", "task", "review", "reply", "share"] as const;

function escapeLike(value: string): string {
  return value.replace(/[!%_]/g, "!$&");
}

function parseStorageCursor(value: string | undefined): { key: number; id: string } | null {
  if (!value) return null;
  const separator = value.lastIndexOf("_");
  const rawKey = separator > 0 ? value.slice(0, separator) : "";
  const id = separator > 0 ? value.slice(separator + 1) : "";
  const key = Number(rawKey);
  if (!/^\d+$/.test(rawKey) || !Number.isSafeInteger(key) || key < 0 || !/^[a-f0-9]{32}$/.test(id)) {
    throw new HttpError(400, "分页参数不正确，请刷新后重试");
  }
  return { key, id };
}

adminRoutes.get("/storage/files", requireSuperAdmin, async (c) => {
  const db = c.env.DB;
  const scope = c.req.query("scope")?.trim() || "";
  if (scope && !STORAGE_FILE_SCOPES.includes(scope as (typeof STORAGE_FILE_SCOPES)[number])) {
    throw new HttpError(400, "附件类型不正确");
  }
  const ownerId = int(c.req.query("owner_id"), "学员ID", { min: 1, optional: true });
  const classId = int(c.req.query("class_id"), "班级ID", { min: 1, optional: true });
  const keyword = str(c.req.query("q"), "搜索关键词", { optional: true, max: 80 });
  const sort = c.req.query("sort") === "created" ? "created" : "size";
  const limit = int(c.req.query("limit"), "每页数量", { min: 1, max: 100, optional: true }) ?? 30;
  const cursor = parseStorageCursor(c.req.query("cursor"));

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (scope) {
    where.push("f.scope = ?");
    params.push(scope);
  }
  if (ownerId) {
    where.push("f.owner_user_id = ?");
    params.push(ownerId);
  }
  if (classId) {
    where.push("u.class_id = ?");
    params.push(classId);
  }
  if (keyword) {
    where.push("f.name LIKE ? ESCAPE '!'");
    params.push(`%${escapeLike(keyword)}%`);
  }
  if (cursor) {
    if (sort === "created") {
      where.push("(f.created_at < ? OR (f.created_at = ? AND f.id > ?))");
    } else {
      where.push("(f.size < ? OR (f.size = ? AND f.id > ?))");
    }
    params.push(cursor.key, cursor.key, cursor.id);
  }

  const orderBy = sort === "created" ? "f.created_at DESC, f.id ASC" : "f.size DESC, f.id ASC";
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const { results } = await db
    .prepare(
      `SELECT f.id, f.name, f.mime, f.size, f.scope,
              f.owner_user_id, f.uploader_id,
              f.log_id, f.task_id, f.share_id, f.reply_id, f.review_event_id,
              f.created_at, u.name AS owner_name, u.username AS owner_username
         FROM files f
         JOIN users u ON u.id = f.owner_user_id
         ${whereSql}
        ORDER BY ${orderBy}
        LIMIT ?`,
    )
    .bind(...params, limit + 1)
    .all<{
      id: string;
      name: string;
      mime: string;
      size: number;
      scope: string;
      owner_user_id: number;
      uploader_id: number;
      log_id: number | null;
      task_id: number | null;
      share_id: number | null;
      reply_id: number | null;
      review_event_id: number | null;
      created_at: number;
      owner_name: string | null;
      owner_username: string | null;
    }>();

  const hasMore = results.length > limit;
  const files = hasMore ? results.slice(0, limit) : results;
  const last = files[files.length - 1];
  return c.json({
    files,
    has_more: hasMore,
    next_cursor: hasMore && last ? `${sort === "created" ? last.created_at : last.size}_${last.id}` : null,
  });
});

/** 批量删除附件：按 D1 参数上限分批 DELETE ... RETURNING 获取对象 key，再统一清理 R2 / KV */
adminRoutes.post("/storage/files/delete", requireSuperAdmin, async (c) => {
  const body = (await c.req.json()) as { ids?: unknown };
  if (!Array.isArray(body.ids)) throw new HttpError(400, "请选择要删除的文件");
  const ids = [...new Set(body.ids.map((id) => String(id)))];
  if (!ids.length) throw new HttpError(400, "请选择要删除的文件");
  if (ids.length > 100) throw new HttpError(400, "单次最多删除 100 个文件");
  if (ids.some((id) => !/^[a-f0-9]{32}$/.test(id))) throw new HttpError(400, "文件 ID 格式不正确");

  // D1 单条 SQL 最多 100 个绑定参数，按 90 个一批执行
  const removed: { id: string; name: string; size: number; r2_key: string }[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await c.env.DB.prepare(
      `DELETE FROM files
        WHERE id IN (${chunk.map(() => "?").join(", ")})
        RETURNING id, name, size, r2_key`,
    )
      .bind(...chunk)
      .all<{ id: string; name: string; size: number; r2_key: string }>();
    removed.push(...results);
  }
  if (!removed.length) throw new HttpError(404, "所选文件不存在或已被删除");

  await deleteStoredObjects(c.env, removed.map((row) => row.r2_key));
  const bytes = removed.reduce((sum, row) => sum + Number(row.size), 0);
  const names = removed
    .slice(0, 3)
    .map((row) => `“${row.name}”`)
    .join("、");
  await audit(
    c,
    removed.length > 1 ? "批量删除附件" : "删除附件",
    `${removed.length} 个，共 ${formatStorageBytes(bytes)}${removed.length > 0 ? `：${names}${removed.length > 3 ? " 等" : ""}` : ""}`,
  ).run();
  return c.json({ ok: true, count: removed.length, bytes });
});

/* ---------------- 班级 ---------------- */

adminRoutes.get("/classes", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.created_at, (SELECT COUNT(*) FROM users u WHERE u.class_id = c.id AND u.role = 'student') AS student_count
       FROM classes c ORDER BY c.id`,
  ).all();
  return c.json({ classes: results });
});

adminRoutes.post("/classes", requireSuperAdmin, async (c) => {
  const body = await c.req.json();
  const name = str(body.name, "班级名称", { max: 40 });
  try {
    const row = await c.env.DB.prepare("INSERT INTO classes (name) VALUES (?) RETURNING id").bind(name).first();
    await audit(c, "新建班级", name).run();
    return c.json({ class: row });
  } catch {
    throw new HttpError(409, "班级名称已存在");
  }
});

adminRoutes.patch("/classes/:id", requireSuperAdmin, async (c) => {
  const id = int(c.req.param("id"), "班级ID")!;
  const name = str((await c.req.json()).name, "班级名称", { max: 40 });
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE classes SET name = ? WHERE id = ?").bind(name, id),
    audit(c, "重命名班级", `#${id} → ${name}`),
  ]);
  return c.json({ ok: true });
});

adminRoutes.delete("/classes/:id", requireSuperAdmin, async (c) => {
  const id = int(c.req.param("id"), "班级ID")!;
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET class_id = NULL WHERE class_id = ?").bind(id),
    c.env.DB.prepare("UPDATE tasks SET class_id = NULL WHERE class_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM task_classes WHERE class_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM classes WHERE id = ?").bind(id),
    audit(c, "删除班级", `#${id}`),
  ]);
  return c.json({ ok: true });
});

/* ---------------- 学员 ---------------- */

adminRoutes.get("/students", async (c) => {
  const db = c.env.DB;
  const page = Math.max(1, int(c.req.query("page"), "页码", { optional: true, min: 1 }) ?? 1);
  const pageSize = Math.min(100, Math.max(20, int(c.req.query("pageSize"), "每页数量", { optional: true, min: 20 }) ?? 50));
  const offset = (page - 1) * pageSize;
  const q = str(c.req.query("q"), "搜索关键词", { optional: true, max: 64 });
  // 班级筛选支持多选（class_ids），可用 unassigned=1 同时包含「未分班」；class_id 保留旧链接兼容
  const classIds = parseIdList(c.req.query("class_ids"));
  const unassigned = c.req.query("unassigned") === "1" || c.req.query("class_id") === "none";
  const classParam = c.req.query("class_id");

  const filters: string[] = ["u.role = 'student'"];
  const binds: unknown[] = [];
  if (classIds.length) {
    const marks = classIds.map(() => "?").join(", ");
    filters.push(unassigned ? `(u.class_id IN (${marks}) OR u.class_id IS NULL)` : `u.class_id IN (${marks})`);
    binds.push(...classIds);
  } else if (unassigned) {
    filters.push("u.class_id IS NULL");
  } else if (classParam) {
    const classId = int(classParam, "班级", { min: 1 })!;
    filters.push("u.class_id = ?");
    binds.push(classId);
  }
  if (q) {
    filters.push("(u.name LIKE ? OR u.username LIKE ?)");
    binds.push(`%${q}%`, `%${q}%`);
  }
  const where = filters.join(" AND ");

  // 一次 GROUP BY 汇总任务完成情况，再按页取学员，避免为每个学员执行多条子查询。
  const [countRes, listRes] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS total FROM users u WHERE ${where}`).bind(...binds),
    db
      .prepare(
        `SELECT u.id, u.username, u.name, u.class_id, c.name AS class_name, u.active, u.must_change_password,
                u.last_login_at, u.created_at,
                a.id AS avatar_id,
                COALESCE(agg.assigned, 0) AS assigned,
                COALESCE(agg.completed, 0) AS completed,
                COALESCE(m.minutes, 0) AS minutes,
                act.last_active_at
           FROM users u
           LEFT JOIN classes c ON c.id = u.class_id
           LEFT JOIN avatars a ON a.user_id = u.id
           LEFT JOIN (
             SELECT u2.id AS user_id,
                    COUNT(t.id) AS assigned,
                    SUM(CASE WHEN p.status = 'approved' THEN 1 ELSE 0 END) AS completed
               FROM users u2
               JOIN tasks t ON t.status = 'published' AND ${audienceSql("t", "u2")}
               LEFT JOIN progress p ON p.task_id = t.id AND p.user_id = u2.id
              WHERE u2.role = 'student'
              GROUP BY u2.id
           ) agg ON agg.user_id = u.id
           LEFT JOIN (
             SELECT user_id, SUM(minutes) AS minutes FROM study_logs GROUP BY user_id
           ) m ON m.user_id = u.id
           LEFT JOIN (
             SELECT user_id, MAX(at) AS last_active_at FROM (
               SELECT user_id, MAX(updated_at) AS at FROM progress GROUP BY user_id
               UNION ALL
               SELECT user_id, MAX(created_at) AS at FROM study_logs GROUP BY user_id
             ) GROUP BY user_id
           ) act ON act.user_id = u.id
          WHERE ${where}
          ORDER BY u.active DESC, u.id DESC
          LIMIT ? OFFSET ?`,
      )
      .bind(...binds, pageSize, offset),
  ]);
  const total = Number((countRes.results[0] as { total: number } | undefined)?.total ?? 0);
  return c.json({ students: listRes.results, total, page, pageSize });
});

/** 发布任务 / 资料时选择名单使用的轻量学员列表，不受学员管理页分页限制 */
adminRoutes.get("/students/options", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.name, u.class_id, c.name AS class_name, u.active
       FROM users u LEFT JOIN classes c ON c.id = u.class_id
      WHERE u.role = 'student' AND u.active = 1
      ORDER BY c.name, u.name, u.id`,
  ).all();
  return c.json({ students: results });
});

adminRoutes.get("/students/:id", async (c) => {
  const id = int(c.req.param("id"), "学员ID")!;
  const db = c.env.DB;
  const [userRes, tasksRes, logsRes, filesRes, logFilesRes, repliesRes, replyFilesRes] = await db.batch([
    db.prepare(
      `SELECT u.id, u.username, u.name, u.class_id, c.name AS class_name, u.active, u.last_login_at, u.created_at,
              (SELECT a.id FROM avatars a WHERE a.user_id = u.id) AS avatar_id
         FROM users u LEFT JOIN classes c ON c.id = u.class_id WHERE u.id = ? AND u.role = 'student'`,
    ).bind(id),
    db.prepare(
      `SELECT t.id, t.title, t.due_date, p.status, COALESCE(p.percent, 0) AS percent, p.note, p.link, p.score, p.updated_at,
              (SELECT COUNT(*) FROM files f WHERE f.scope = 'progress' AND f.task_id = t.id AND f.owner_user_id = u.id) AS file_count
         FROM tasks t JOIN users u ON u.id = ? AND ${audienceSql("t", "u")}
         LEFT JOIN progress p ON p.task_id = t.id AND p.user_id = u.id
        WHERE t.status = 'published' ORDER BY t.id DESC`,
    ).bind(id),
    db.prepare(
      `SELECT l.id, l.user_id, l.minutes, l.content, l.log_date, l.task_id, t.title AS task_title
         FROM study_logs l LEFT JOIN tasks t ON t.id = l.task_id
        WHERE l.user_id = ? ORDER BY l.log_date DESC, l.id DESC`,
    ).bind(id),
    db.prepare(
      `SELECT id, task_id, name, mime, size, created_at FROM files
        WHERE scope = 'progress' AND owner_user_id = ? ORDER BY created_at, id`,
    ).bind(id),
    db.prepare(
      `SELECT f.id, f.log_id, f.uploader_id, f.name, f.mime, f.size, f.created_at
         FROM files f JOIN study_logs l ON l.id = f.log_id
        WHERE l.user_id = ? AND f.reply_id IS NULL ORDER BY f.created_at, f.id`,
    ).bind(id),
    db.prepare(
      `SELECT r.id, r.log_id, r.parent_id, r.content, r.created_at, r.user_id, u.name AS author_name, u.role AS author_role,
              (SELECT a.id FROM avatars a WHERE a.user_id = r.user_id) AS author_avatar_id
         FROM log_replies r JOIN users u ON u.id = r.user_id JOIN study_logs l ON l.id = r.log_id
        WHERE l.user_id = ? ORDER BY r.id`,
    ).bind(id),
    db.prepare(
      `SELECT f.id, f.reply_id, f.name, f.mime, f.size, f.created_at
         FROM files f JOIN study_logs l ON l.id = f.log_id
        WHERE l.user_id = ? AND f.scope = 'reply' ORDER BY f.created_at, f.id`,
    ).bind(id),
  ]);
  if (!userRes.results[0]) throw new HttpError(404, "学员不存在");
  const logFiles = groupBy(logFilesRes.results as Record<string, unknown>[], "log_id");
  const replyFiles = groupBy(replyFilesRes.results as Record<string, unknown>[], "reply_id");
  const replies = groupBy(repliesRes.results as Record<string, unknown>[], "log_id");
  return c.json({
    student: userRes.results[0],
    tasks: tasksRes.results,
    files: filesRes.results,
    logs: logsRes.results.map((log: any) => ({
      ...log,
      files: logFiles.get(log.id) ?? [],
      replies: ((replies.get(log.id) ?? []) as any[]).map((reply) => ({
        ...reply,
        files: replyFiles.get(reply.id) ?? [],
      })),
    })),
  });
});

adminRoutes.post("/students", requireSuperAdmin, async (c) => {
  const body = await c.req.json();
  const u = username(body.username);
  const name = str(body.name, "姓名", { max: 32 });
  const classId = int(body.class_id, "班级", { optional: true });
  const link = siteUrl(body.site_url, new URL(c.req.url).origin);
  // 单个添加也使用系统随机生成的复杂密码（大小写字母 + 数字 + 符号），并直接生成账号信息
  const plain = randomPassword(22);
  const hash = await hashPassword(plain);
  try {
    const row = await c.env.DB.prepare(
      "INSERT INTO users (username, name, password_hash, role, class_id, must_change_password) VALUES (?, ?, ?, 'student', ?, 0) RETURNING id",
    )
      .bind(u, name, hash, classId)
      .first();
    await audit(c, "新增学员", `${name}（${u}）`).run();
    return c.json({ student: row, account: { username: u, name, password: plain, site_url: link } satisfies GeneratedAccount });
  } catch {
    throw new HttpError(409, "用户名已存在");
  }
});

// 批量导入：为每位新学员生成独立的 22 位随机密码，并返回账号信息（前端展示后可复制或下载 ZIP）
adminRoutes.post("/students/batch", requireSuperAdmin, async (c) => {
  const db = c.env.DB;
  const body = await c.req.json();
  const classId = int(body.class_id, "班级", { optional: true });
  const link = siteUrl(body.site_url, new URL(c.req.url).origin);
  const lines = String(body.lines ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) throw new HttpError(400, "请至少输入一行学员信息");
  if (lines.length > 500) throw new HttpError(400, "单次最多导入 500 名学员");

  const seen = new Set<string>();
  const rows: { username: string; name: string }[] = [];
  for (const [i, line] of lines.entries()) {
    const [rawUser, ...rest] = line.split(/[,，\t\s]+/);
    try {
      const parsed = { username: username(rawUser), name: str(rest.join(" ") || rawUser, "姓名", { max: 32 }) };
      const key = parsed.username.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(parsed);
    } catch (e) {
      throw new HttpError(400, `第 ${i + 1} 行：${(e as Error).message}`);
    }
  }

  // 先排除已存在的用户名，只为真正新增的账号计算密码哈希，减少不必要的 CPU 消耗
  const existing = new Set<string>();
  for (let i = 0; i < rows.length; i += 90) {
    const chunk = rows.slice(i, i + 90);
    const result = await db
      .prepare(`SELECT username FROM users WHERE username IN (${chunk.map(() => "?").join(", ")})`)
      .bind(...chunk.map((r) => r.username))
      .all<{ username: string }>();
    for (const row of result.results) existing.add(row.username.toLowerCase());
  }
  const fresh = rows.filter((r) => !existing.has(r.username.toLowerCase()));
  const skipped = lines.length - fresh.length;
  if (!fresh.length) throw new HttpError(409, "名单中的用户名均已存在，没有需要导入的学员");

  const withPasswords = await Promise.all(
    fresh.map(async (r) => {
      const plain = randomPassword(22);
      return { ...r, password: plain, hash: await hashPassword(plain) };
    }),
  );

  const created: { username: string; name: string; password: string }[] = [];
  for (let i = 0; i < withPasswords.length; i += 50) {
    const chunk = withPasswords.slice(i, i + 50);
    const results = await db.batch(
      chunk.map((r) =>
        db
          .prepare(
            `INSERT OR IGNORE INTO users (username, name, password_hash, role, class_id, must_change_password)
             VALUES (?, ?, ?, 'student', ?, 0)`,
          )
          .bind(r.username, r.name, r.hash, classId),
      ),
    );
    results.forEach((result, index) => {
      if ((result.meta.changes ?? 0) > 0) {
        const { username, name, password } = chunk[index];
        created.push({ username, name, password });
      }
    });
  }
  if (!created.length) throw new HttpError(409, "没有创建任何学员，请检查名单后重试");

  const now = new Date();
  const stamp = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const accounts: GeneratedAccount[] = created.map((r) => ({ ...r, site_url: link }));
  const encoder = new TextEncoder();
  const zip = createZip([
    ...accounts.map((account) => ({
      name: `${account.username}_学迹账号_${stamp}.txt`,
      data: encoder.encode(`${accountText(account, 1, 1)}\n`),
    })),
    // 批量导入额外生成一份汇总文档，方便一次性复制或归档
    { name: `学迹账号汇总_${stamp}.txt`, data: encoder.encode(accountsText(accounts)) },
  ]);
  await audit(c, "批量导入学员", `${created.length} 名`).run();
  const fileName = `学迹账号_${stamp}.zip`;
  return c.json({
    created: accounts.length,
    skipped,
    accounts,
    zipName: fileName,
    zip: toBase64(zip),
  });
});

adminRoutes.patch("/students/:id", async (c) => {
  const id = int(c.req.param("id"), "学员ID")!;
  const body = await c.req.json();
  if (!c.get("user").is_super_admin && body.password !== undefined) {
    throw new HttpError(403, "辅导员不能重置学员密码");
  }
  if (!c.get("user").is_super_admin && (body.active !== undefined || body.class_id !== undefined)) {
    throw new HttpError(403, "仅管理员可以调整学员班级或启用/停用账号");
  }
  const db = c.env.DB;
  const stmts: D1PreparedStatement[] = [];
  const student = await db.prepare("SELECT name, username FROM users WHERE id = ? AND role = 'student'").bind(id).first<{ name: string; username: string }>();
  if (!student) throw new HttpError(404, "学员不存在");
  const label = `${student.name}（${student.username}）`;

  if (body.name !== undefined) stmts.push(db.prepare("UPDATE users SET name = ? WHERE id = ? AND role = 'student'").bind(str(body.name, "姓名", { max: 32 }), id));
  if (body.class_id !== undefined) stmts.push(db.prepare("UPDATE users SET class_id = ? WHERE id = ? AND role = 'student'").bind(int(body.class_id, "班级", { optional: true }), id));
  if (body.active !== undefined) {
    stmts.push(db.prepare("UPDATE users SET active = ? WHERE id = ? AND role = 'student'").bind(body.active ? 1 : 0, id));
    if (!body.active) stmts.push(db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id));
    stmts.push(audit(c, body.active ? "启用学员" : "停用学员", label));
  }
  if (body.password !== undefined) {
    const hash = await hashPassword(password(body.password));
    stmts.push(
      db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1, failed_attempts = 0, locked_until = 0 WHERE id = ? AND role = 'student'").bind(hash, id),
      db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
      audit(c, "重置学员密码", label),
    );
  }
  if (body.class_id !== undefined || body.name !== undefined) stmts.push(audit(c, "编辑学员信息", label));
  if (stmts.length) await db.batch(stmts);
  return c.json({ ok: true });
});

adminRoutes.delete("/students/:id", requireSuperAdmin, async (c) => {
  const id = int(c.req.param("id"), "学员ID")!;
  const student = await c.env.DB.prepare("SELECT name, username FROM users WHERE id = ? AND role = 'student'").bind(id).first<{ name: string; username: string }>();
  if (!student) throw new HttpError(404, "学员不存在");
  const keys = await fileKeysForUser(c.env, id);
  const avatarKeys = await avatarKeysForUser(c.env, id);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM users WHERE id = ? AND role = 'student'").bind(id),
    audit(c, "删除学员", `${student.name}（${student.username}）`),
  ]);
  await deleteStoredObjects(c.env, [...keys, ...avatarKeys]);
  return c.json({ ok: true });
});

/** 批量启用 / 停用 / 调整班级 */
adminRoutes.post("/students/batch-update", requireSuperAdmin, async (c) => {
  const body = await c.req.json();
  const ids = normalizeIdList(body.ids, "学员", 2000);
  if (!ids.length) throw new HttpError(400, "请选择要操作的学员");
  const hasActive = body.active !== undefined;
  const hasClass = body.class_id !== undefined;
  if (!hasActive && !hasClass) throw new HttpError(400, "没有需要修改的内容");
  const active = hasActive ? (body.active ? 1 : 0) : undefined;
  const classId = hasClass ? int(body.class_id, "班级", { optional: true }) : undefined;
  const db = c.env.DB;

  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const placeholders = chunk.map(() => "?").join(", ");
    const stmts: D1PreparedStatement[] = [];
    if (hasActive) {
      stmts.push(db.prepare(`UPDATE users SET active = ? WHERE role = 'student' AND id IN (${placeholders})`).bind(active!, ...chunk));
      if (!active) stmts.push(db.prepare(`DELETE FROM sessions WHERE user_id IN (${placeholders})`).bind(...chunk));
    }
    if (hasClass) {
      stmts.push(db.prepare(`UPDATE users SET class_id = ? WHERE role = 'student' AND id IN (${placeholders})`).bind(classId ?? null, ...chunk));
    }
    await db.batch(stmts);
  }

  const actions = [hasActive ? (active ? "批量启用学员" : "批量停用学员") : "", hasClass ? "批量调整学员班级" : ""].filter(Boolean);
  await audit(c, actions.join(" · "), `${ids.length} 名`).run();
  return c.json({ ok: true, count: ids.length });
});

/** 批量重置学员密码：按创建账号的规则为每位学员生成 22 位随机密码，学员无需自行修改 */
adminRoutes.post("/students/batch-reset-password", requireSuperAdmin, async (c) => {
  const body = await c.req.json();
  const ids = normalizeIdList(body.ids, "学员", 500);
  if (!ids.length) throw new HttpError(400, "请选择要重置密码的学员");
  const db = c.env.DB;

  const students: { id: number; name: string; username: string }[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const result = await db
      .prepare(`SELECT id, name, username FROM users WHERE role = 'student' AND id IN (${chunk.map(() => "?").join(", ")})`)
      .bind(...chunk)
      .all<{ id: number; name: string; username: string }>();
    students.push(...result.results);
  }
  if (!students.length) throw new HttpError(404, "所选学员不存在");

  const link = siteUrl(body.site_url, new URL(c.req.url).origin);
  const withPasswords = await Promise.all(
    students.map(async (s) => {
      const generated = randomPassword(22);
      return { ...s, password: generated, hash: await hashPassword(generated) };
    }),
  );

  // must_change_password = 0：与创建账号一致，学员可直接使用随机密码登录
  const resetSql = "UPDATE users SET password_hash = ?, must_change_password = 0, failed_attempts = 0, locked_until = 0 WHERE id = ? AND role = 'student'";
  for (let i = 0; i < withPasswords.length; i += 50) {
    await db.batch(withPasswords.slice(i, i + 50).map((s) => db.prepare(resetSql).bind(s.hash, s.id)));
  }

  // 重置密码后旧登录状态立即失效
  for (let i = 0; i < students.length; i += 90) {
    const chunk = students.slice(i, i + 90);
    await db
      .prepare(`DELETE FROM sessions WHERE user_id IN (${chunk.map(() => "?").join(", ")})`)
      .bind(...chunk.map((s) => s.id))
      .run();
  }

  const now = new Date();
  const stamp = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const accounts: GeneratedAccount[] = withPasswords.map((s) => ({
    username: s.username,
    name: s.name,
    password: s.password,
    site_url: link,
  }));
  const encoder = new TextEncoder();
  const zip = createZip([
    ...accounts.map((account) => ({
      name: `${account.username}_学迹账号_${stamp}.txt`,
      data: encoder.encode(`${accountText(account, 1, 1)}\n`),
    })),
    { name: `学迹账号汇总_${stamp}.txt`, data: encoder.encode(accountsText(accounts)) },
  ]);

  await audit(c, students.length > 1 ? "批量重置学员密码" : "重置学员密码", `${students.length} 名（随机生成）`).run();
  return c.json({
    ok: true,
    count: students.length,
    accounts,
    zipName: `学迹账号_${stamp}.zip`,
    zip: toBase64(zip),
  });
});

/** 批量删除学员，同时清理其附件与头像 */
adminRoutes.post("/students/batch-delete", requireSuperAdmin, async (c) => {
  const body = await c.req.json();
  const ids = normalizeIdList(body.ids, "学员", 500);
  if (!ids.length) throw new HttpError(400, "请选择要删除的学员");
  const db = c.env.DB;
  const students: { id: number; name: string; username: string }[] = [];
  const keys: string[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const chunkPlaceholders = chunk.map(() => "?").join(", ");
    const [usersRes, filesRes, avatarsRes] = await db.batch([
      db.prepare(`SELECT id, name, username FROM users WHERE role = 'student' AND id IN (${chunkPlaceholders})`).bind(...chunk),
      db
        .prepare(`SELECT r2_key FROM files WHERE uploader_id IN (${chunkPlaceholders}) OR owner_user_id IN (${chunkPlaceholders})`)
        .bind(...chunk, ...chunk),
      db.prepare(`SELECT storage_key FROM avatars WHERE user_id IN (${chunkPlaceholders})`).bind(...chunk),
    ]);
    students.push(...(usersRes.results as { id: number; name: string; username: string }[]));
    keys.push(...(filesRes.results as { r2_key: string }[]).map((row) => row.r2_key));
    keys.push(...(avatarsRes.results as { storage_key: string }[]).map((row) => row.storage_key));
  }
  if (!students.length) throw new HttpError(404, "所选学员不存在");

  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    await db
      .prepare(`DELETE FROM users WHERE role = 'student' AND id IN (${chunk.map(() => "?").join(", ")})`)
      .bind(...chunk)
      .run();
  }
  await deleteStoredObjects(c.env, keys);
  const names = students.slice(0, 3).map((row) => `${row.name}（${row.username}）`).join("、");
  await audit(c, "批量删除学员", `${students.length} 名${students.length > 3 ? `：${names} 等` : `：${names}`}`).run();
  return c.json({ ok: true, count: students.length });
});

/* ---------------- 任务 ---------------- */

adminRoutes.get("/tasks", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.title, t.tech_tags, t.class_id, cl.name AS class_name,
            (SELECT GROUP_CONCAT(c.name, '、') FROM task_classes tc JOIN classes c ON c.id = tc.class_id WHERE tc.task_id = t.id) AS class_names,
            (SELECT u.name FROM users u WHERE u.id = t.created_by) AS creator_name,
            t.due_date, t.status, t.require_review, t.priority, t.pinned, t.pinned_at, t.created_at,
            (SELECT COUNT(*) FROM task_steps s WHERE s.task_id = t.id) AS step_count,
            COUNT(u.id) AS assigned,
            COALESCE(SUM(p.status = 'approved'), 0) AS approved,
            COALESCE(SUM(p.status = 'submitted'), 0) AS submitted,
            COALESCE(SUM(p.status IN ('doing', 'rejected')), 0) AS doing
       FROM tasks t LEFT JOIN classes cl ON cl.id = t.class_id
       LEFT JOIN users u ON ${ELIGIBLE}
       LEFT JOIN progress p ON p.task_id = t.id AND p.user_id = u.id
      GROUP BY t.id
      ORDER BY CASE t.status WHEN 'published' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, t.pinned DESC, t.pinned_at DESC, t.priority DESC, t.id DESC`,
  ).all();
  return c.json({ tasks: results });
});

function parseTask(body: any) {
  const status = ["draft", "published", "archived"].includes(body.status) ? body.status : "published";
  const classIds = normalizeIdList(body.class_ids ?? (body.class_id ? [body.class_id] : []), "班级", 100);
  const excludedUserIds = normalizeIdList(body.excluded_user_ids, "排除学员", 2000);
  return {
    title: str(body.title, "任务标题", { max: 100 }),
    description: str(body.description, "任务说明", { optional: true, max: 20000 }),
    tech_tags: normalizeTags(body.tech_tags),
    class_id: classIds[0] ?? null,
    class_ids: classIds,
    excluded_user_ids: excludedUserIds,
    audience_mode: body.audience_mode === "include" ? "include" : "exclude",
    due_date: dateStr(body.due_date, "截止日期"),
    status,
    require_review: body.require_review === false || body.require_review === 0 ? 0 : 1,
    priority: int(body.priority, "优先级", { min: 0, max: 3, optional: true }) ?? 0,
    steps: normalizeSteps(body.steps),
    file_ids: normalizeFileIds(body.file_ids, MAX_TASK_FILES),
    remove_file_ids: normalizeFileIds(body.remove_file_ids, MAX_TASK_FILES),
  };
}

adminRoutes.post("/tasks", async (c) => {
  const t = parseTask(await c.req.json());
  const me = c.get("user");
  const db = c.env.DB;
  const row = await db
    .prepare(
      `INSERT INTO tasks (title, description, tech_tags, class_id, due_date, status, require_review, priority, audience_mode, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(t.title, t.description, t.tech_tags, t.class_id, t.due_date, t.status, t.require_review, t.priority, t.audience_mode, me.id)
    .first<{ id: number }>();
  await db.batch([
    ...t.steps.map((s, i) => db.prepare("INSERT INTO task_steps (task_id, title, position) VALUES (?, ?, ?)").bind(row!.id, s.title, i)),
    ...audienceStatements(db, row!.id, t.class_ids, t.excluded_user_ids),
    audit(c, "创建任务", t.title),
  ]);
  if (t.file_ids.length) await bindTaskFiles(c.env, me.id, row!.id, t.file_ids);
  if (t.status === "published") {
    const userIds = await taskAudienceUserIds(c.env, row!.id);
    await notifyTaskUsers(c.env, userIds, `新任务：《${t.title}》`, row!.id);
  }
  return c.json({ task: row });
});

adminRoutes.get("/tasks/:id", async (c) => {
  const id = int(c.req.param("id"), "任务ID")!;
  const db = c.env.DB;
  const [taskRes, stepsRes, rosterRes, filesRes, classRes, excludedRes, taskFilesRes] = await db.batch([
    db.prepare(
      `SELECT t.*, cl.name AS class_name,
              (SELECT GROUP_CONCAT(c.name, '、') FROM task_classes tc JOIN classes c ON c.id = tc.class_id WHERE tc.task_id = t.id) AS class_names,
              (SELECT u.name FROM users u WHERE u.id = t.created_by) AS creator_name,
              (SELECT a.id FROM avatars a WHERE a.user_id = t.created_by) AS creator_avatar_id
         FROM tasks t LEFT JOIN classes cl ON cl.id = t.class_id WHERE t.id = ?`,
    ).bind(id),
    db.prepare("SELECT id, title, position FROM task_steps WHERE task_id = ? ORDER BY position, id").bind(id),
    db.prepare(
      `SELECT u.id AS user_id, u.name, u.username, cl.name AS class_name,
              (SELECT a.id FROM avatars a WHERE a.user_id = u.id) AS avatar_id,
              p.status, COALESCE(p.percent, 0) AS percent, p.note, p.link, p.review_comment, p.score, p.submitted_at, p.updated_at,
              (SELECT COUNT(*) FROM files f WHERE f.scope = 'progress' AND f.task_id = t.id AND f.owner_user_id = u.id) AS file_count,
              (SELECT ue.due_at FROM task_urges ue
                WHERE ue.task_id = t.id AND ue.user_id = u.id
                ORDER BY ue.due_at DESC, ue.id DESC LIMIT 1) AS urge_due_at,
              (SELECT ue.message FROM task_urges ue
                WHERE ue.task_id = t.id AND ue.user_id = u.id
                ORDER BY ue.due_at DESC, ue.id DESC LIMIT 1) AS urge_message
         FROM tasks t JOIN users u ON ${ELIGIBLE}
         LEFT JOIN classes cl ON cl.id = u.class_id
         LEFT JOIN progress p ON p.task_id = t.id AND p.user_id = u.id
        WHERE t.id = ?
        ORDER BY CASE p.status WHEN 'submitted' THEN 0 WHEN 'rejected' THEN 1 WHEN 'doing' THEN 2 WHEN 'approved' THEN 3 ELSE 4 END,
                 COALESCE(p.percent, 0) DESC, u.id`,
    ).bind(id),
    db.prepare(
      `SELECT id, owner_user_id, name, mime, size, created_at FROM files
        WHERE scope = 'progress' AND task_id = ? ORDER BY created_at, id`,
    ).bind(id),
    db.prepare("SELECT class_id FROM task_classes WHERE task_id = ? ORDER BY class_id").bind(id),
    db.prepare("SELECT user_id FROM task_exclusions WHERE task_id = ? ORDER BY user_id").bind(id),
    db.prepare("SELECT id, name, mime, size, created_at FROM files WHERE scope = 'task' AND task_id = ? ORDER BY created_at, id").bind(id),
  ]);
  if (!taskRes.results[0]) throw new HttpError(404, "任务不存在");
  return c.json({
    task: taskRes.results[0],
    steps: stepsRes.results,
    roster: rosterRes.results,
    files: filesRes.results,
    task_files: taskFilesRes.results,
    class_ids: (classRes.results as { class_id: number }[]).map((row) => row.class_id),
    excluded_user_ids: (excludedRes.results as { user_id: number }[]).map((row) => row.user_id),
  });
});

adminRoutes.put("/tasks/:id", async (c) => {
  const id = int(c.req.param("id"), "任务ID")!;
  const t = parseTask(await c.req.json());
  const me = c.get("user");
  const db = c.env.DB;
  const [found, existing] = await db.batch<{ id: number; status: string }>([
    db.prepare("SELECT id, status FROM tasks WHERE id = ?").bind(id),
    db.prepare("SELECT id FROM task_steps WHERE task_id = ?").bind(id),
  ]);
  const previous = found.results[0];
  if (!previous) throw new HttpError(404, "任务不存在");
  const oldAudience = previous.status === "published" ? new Set(await taskAudienceUserIds(c.env, id)) : new Set<number>();
  const existingIds = new Set(existing.results.map((r) => r.id));
  const keepIds = new Set(t.steps.filter((s) => s.id && existingIds.has(s.id)).map((s) => s.id!));

  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE tasks SET title = ?, description = ?, tech_tags = ?, class_id = ?, due_date = ?, status = ?, require_review = ?, priority = ?, audience_mode = ?, updated_at = unixepoch(),
                pinned = CASE WHEN ? = 'archived' THEN 0 ELSE pinned END,
                pinned_at = CASE WHEN ? = 'archived' THEN NULL ELSE pinned_at END,
                pinned_by = CASE WHEN ? = 'archived' THEN NULL ELSE pinned_by END
          WHERE id = ?`,
      )
      .bind(t.title, t.description, t.tech_tags, t.class_id, t.due_date, t.status, t.require_review, t.priority, t.audience_mode, t.status, t.status, t.status, id),
  ];
  for (const oldId of existingIds) {
    if (!keepIds.has(oldId)) stmts.push(db.prepare("DELETE FROM task_steps WHERE id = ?").bind(oldId));
  }
  t.steps.forEach((s, i) => {
    stmts.push(
      s.id && keepIds.has(s.id)
        ? db.prepare("UPDATE task_steps SET title = ?, position = ? WHERE id = ?").bind(s.title, i, s.id)
        : db.prepare("INSERT INTO task_steps (task_id, title, position) VALUES (?, ?, ?)").bind(id, s.title, i),
    );
  });
  if (t.steps.length) {
    stmts.push(
      db
        .prepare(
          `UPDATE progress SET percent = (SELECT CAST(COUNT(*) * 100 / CAST(?2 AS INTEGER) AS INTEGER) FROM step_checks sc WHERE sc.task_id = ?1 AND sc.user_id = progress.user_id)
            WHERE task_id = ?1 AND status IN ('doing', 'rejected')`,
        )
        .bind(id, t.steps.length),
    );
  }
  stmts.push(...audienceStatements(db, id, t.class_ids, t.excluded_user_ids));
  stmts.push(audit(c, "编辑任务", t.title));
  await db.batch(stmts);
  if (t.remove_file_ids.length) await detachTaskFiles(c.env, me.id, id, t.remove_file_ids);
  if (t.file_ids.length) await bindTaskFiles(c.env, me.id, id, t.file_ids);
  if (t.status === "published") {
    const nextAudience = await taskAudienceUserIds(c.env, id);
    const fresh = nextAudience.filter((userId) => !oldAudience.has(userId));
    await notifyTaskUsers(c.env, fresh, `新任务：《${t.title}》`, id);
  }
  return c.json({ ok: true });
});

adminRoutes.post("/tasks/:id/duplicate", async (c) => {
  const id = int(c.req.param("id"), "任务ID")!;
  const me = c.get("user");
  const db = c.env.DB;
  const row = await db
    .prepare(
      `INSERT INTO tasks (title, description, tech_tags, class_id, due_date, status, require_review, priority, audience_mode, created_by)
       SELECT substr(title || '（副本）', 1, 100), description, tech_tags, class_id, NULL, 'draft', require_review, priority, audience_mode, ?
         FROM tasks WHERE id = ?
       RETURNING id, title`,
    )
    .bind(me.id, id)
    .first<{ id: number; title: string }>();
  if (!row) throw new HttpError(404, "任务不存在");
  await db.batch([
    db.prepare("INSERT INTO task_steps (task_id, title, position) SELECT ?, title, position FROM task_steps WHERE task_id = ? ORDER BY position, id").bind(row.id, id),
    db.prepare("INSERT INTO task_classes (task_id, class_id) SELECT ?, class_id FROM task_classes WHERE task_id = ?").bind(row.id, id),
    db.prepare("INSERT INTO task_exclusions (task_id, user_id) SELECT ?, user_id FROM task_exclusions WHERE task_id = ?").bind(row.id, id),
    audit(c, "复制任务", row.title),
  ]);
  return c.json({ task: row });
});

adminRoutes.post("/tasks/:id/pin", async (c) => {
  const id = int(c.req.param("id"), "任务ID")!;
  const body = await c.req.json();
  const pinned = body.pinned === true;
  const db = c.env.DB;
  const task = await db.prepare("SELECT id, title, status, pinned FROM tasks WHERE id = ?").bind(id).first<{ id: number; title: string; status: string; pinned: number }>();
  if (!task) throw new HttpError(404, "任务不存在");
  if (pinned && task.status !== "published") throw new HttpError(400, "只有已发布的任务可以置顶");

  if (pinned && !task.pinned) {
    const count = await db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE pinned = 1 AND status = 'published'").first<{ n: number }>();
    if ((count?.n ?? 0) >= 5) throw new HttpError(400, "最多置顶 5 个任务，请先取消其他置顶");
  }
  await db.batch([
    pinned
      ? db.prepare("UPDATE tasks SET pinned = 1, pinned_at = unixepoch(), pinned_by = ?, updated_at = unixepoch() WHERE id = ?").bind(c.get("user").id, id)
      : db.prepare("UPDATE tasks SET pinned = 0, pinned_at = NULL, pinned_by = NULL, updated_at = unixepoch() WHERE id = ?").bind(id),
    audit(c, pinned ? "置顶任务" : "取消置顶任务", task.title),
  ]);
  return c.json({ ok: true, pinned });
});

adminRoutes.delete("/tasks/:id", async (c) => {
  const id = int(c.req.param("id"), "任务ID")!;
  const db = c.env.DB;
  const task = await db.prepare("SELECT title FROM tasks WHERE id = ?").bind(id).first<{ title: string }>();
  if (!task) throw new HttpError(404, "任务不存在");
  const keys = await fileKeysForTask(c.env, id);
  await db.batch([db.prepare("DELETE FROM tasks WHERE id = ?").bind(id), audit(c, "删除任务", task.title)]);
  await deleteStoredObjects(c.env, keys);
  return c.json({ ok: true });
});

/** 批量归档 / 修改状态 / 添加或移除技术标签 */
adminRoutes.post("/tasks/batch-update", async (c) => {
  const body = await c.req.json();
  const ids = normalizeIdList(body.ids, "任务", 500);
  if (!ids.length) throw new HttpError(400, "请选择要操作的任务");
  const hasStatus = body.status !== undefined;
  if (hasStatus && !["draft", "published", "archived"].includes(String(body.status))) throw new HttpError(400, "任务状态无效");
  const addTags = tagList(body.add_tags);
  const removeTags = new Set(tagList(body.remove_tags).map((tag) => tag.toLowerCase()));
  if (!hasStatus && !addTags.length && !removeTags.size) throw new HttpError(400, "没有需要修改的内容");
  const status = hasStatus ? String(body.status) : undefined;
  const db = c.env.DB;
  let count = 0;

  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const placeholders = chunk.map(() => "?").join(", ");
    const { results } = await db
      .prepare(`SELECT id, tech_tags FROM tasks WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all<{ id: number; tech_tags: string | null }>();
    const stmts: D1PreparedStatement[] = [];
    for (const row of results) {
      const sets: string[] = [];
      const binds: (string | number)[] = [];
      if (status) {
        sets.push("status = ?", "updated_at = unixepoch()");
        binds.push(status);
        if (status === "archived") sets.push("pinned = 0", "pinned_at = NULL", "pinned_by = NULL");
      }
      if (addTags.length || removeTags.size) {
        const kept = (row.tech_tags ?? "")
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean)
          .filter((tag) => !removeTags.has(tag.toLowerCase()));
        for (const tag of addTags) {
          if (!kept.some((old) => old.toLowerCase() === tag.toLowerCase())) kept.push(tag);
        }
        sets.push("tech_tags = ?", "updated_at = unixepoch()");
        binds.push(kept.slice(0, 12).join(","));
      }
      if (!sets.length) continue;
      binds.push(row.id);
      stmts.push(db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).bind(...binds));
    }
    if (stmts.length) await db.batch(stmts);
    count += results.length;
  }

  const actions = [
    hasStatus ? (status === "archived" ? "批量归档任务" : status === "published" ? "批量发布任务" : "批量转为草稿") : "",
    addTags.length ? "批量添加任务标签" : "",
    removeTags.size ? "批量移除任务标签" : "",
  ].filter(Boolean);
  await audit(c, actions.join(" · "), `${count} 个任务`).run();
  return c.json({ ok: true, count });
});

/** 批量删除任务，同时清理任务附件与学员提交的文件 */
adminRoutes.post("/tasks/batch-delete", async (c) => {
  const body = await c.req.json();
  const ids = normalizeIdList(body.ids, "任务", 500);
  if (!ids.length) throw new HttpError(400, "请选择要删除的任务");
  const db = c.env.DB;
  const found: { id: number; title: string }[] = [];
  const keys: string[] = [];

  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const placeholders = chunk.map(() => "?").join(", ");
    const [tasksRes, filesRes] = await db.batch([
      db.prepare(`SELECT id, title FROM tasks WHERE id IN (${placeholders})`).bind(...chunk),
      db.prepare(`SELECT r2_key FROM files WHERE task_id IN (${placeholders})`).bind(...chunk),
    ]);
    found.push(...(tasksRes.results as { id: number; title: string }[]));
    keys.push(...(filesRes.results as { r2_key: string }[]).map((row) => row.r2_key));
  }
  if (!found.length) throw new HttpError(404, "所选任务不存在");

  const existingIds = found.map((row) => row.id);
  for (let i = 0; i < existingIds.length; i += 90) {
    const chunk = existingIds.slice(i, i + 90);
    await db
      .prepare(`DELETE FROM tasks WHERE id IN (${chunk.map(() => "?").join(", ")})`)
      .bind(...chunk)
      .run();
  }
  await deleteStoredObjects(c.env, keys);
  const titles = found.slice(0, 3).map((row) => row.title).join("、");
  await audit(c, "批量删除任务", `${found.length} 个${found.length > 3 ? `：${titles} 等` : `：${titles}`}`).run();
  return c.json({ ok: true, count: found.length });
});

/* ---------------- 资料分享 ---------------- */

function parseShare(body: any) {
  const status = ["draft", "published", "archived"].includes(body.status) ? body.status : "published";
  const classIds = normalizeIdList(body.class_ids ?? (body.class_id ? [body.class_id] : []), "班级", 100);
  const excludedUserIds = normalizeIdList(body.excluded_user_ids, "排除学员", 2000);
  return {
    title: str(body.title, "资料标题", { max: 100 }),
    description: str(body.description, "资料内容", { optional: true, max: 20000 }),
    tech_tags: normalizeTags(body.tech_tags),
    class_ids: classIds,
    excluded_user_ids: excludedUserIds,
    audience_all: classIds.length ? 0 : 1,
    audience_mode: body.audience_mode === "include" ? "include" : "exclude",
    status,
    notify: body.notify === true,
    file_ids: normalizeFileIds(body.file_ids, MAX_SHARE_FILES),
    remove_file_ids: normalizeFileIds(body.remove_file_ids, MAX_SHARE_FILES),
  };
}

adminRoutes.get("/shares", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.title, s.tech_tags, s.status, s.audience_all, s.audience_mode, s.pinned, s.pinned_at,
            s.view_count, s.created_at, s.updated_at,
            substr(s.description, 1, 200) AS excerpt,
            (SELECT u.name FROM users u WHERE u.id = s.created_by) AS creator_name,
            (SELECT GROUP_CONCAT(c.name, '、') FROM share_classes sc JOIN classes c ON c.id = sc.class_id WHERE sc.share_id = s.id) AS class_names,
            (SELECT COUNT(*) FROM files f WHERE f.scope = 'share' AND f.share_id = s.id) AS file_count
       FROM shares s
      ORDER BY CASE s.status WHEN 'published' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
               s.pinned DESC, s.created_at DESC, s.id DESC`,
  ).all();
  return c.json({ shares: results });
});

/** 批量导出资料：可一次选择多篇，正文写入 Markdown，附件一并打包为 ZIP */
adminRoutes.get("/shares/export", async (c) => {
  const me = c.get("user");
  const origin = new URL(c.req.url).origin;
  const ids = parseShareIds(c.req.query("share_ids"));
  const idFilter = ids.length ? ` AND s.id IN (${ids.map((_, i) => `?${i + 1}`).join(", ")})` : "";
  const stmt = c.env.DB.prepare(
    `SELECT s.id, s.title, s.description, s.tech_tags, s.status, s.audience_all,
            s.view_count, s.created_at, s.updated_at,
            (SELECT u.name FROM users u WHERE u.id = s.created_by) AS creator_name,
            (SELECT GROUP_CONCAT(c.name, '、') FROM share_classes sc JOIN classes c ON c.id = sc.class_id WHERE sc.share_id = s.id) AS class_names
       FROM shares s
      WHERE 1 = 1${idFilter}
      ORDER BY CASE s.status WHEN 'published' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
               s.pinned DESC, s.created_at DESC, s.id DESC`,
  );
  const { results: shares } = await (ids.length ? stmt.bind(...ids) : stmt).all<{
    id: number;
    title: string;
    description: string;
    tech_tags: string;
    status: string;
    audience_all: number;
    view_count: number;
    created_at: number;
    updated_at: number;
    creator_name: string | null;
    class_names: string | null;
  }>();

  const shareIds = shares.map((share) => share.id);
  let files: { id: string; share_id: number; name: string; mime: string; size: number }[] = [];
  if (shareIds.length) {
    const { results } = await c.env.DB.prepare(
      `SELECT id, share_id, name, mime, size FROM files
        WHERE scope = 'share' AND share_id IN (${shareIds.map(() => "?").join(", ")})
        ORDER BY created_at, id`,
    )
      .bind(...shareIds)
      .all<{ id: string; share_id: number; name: string; mime: string; size: number }>();
    files = results;
  }

  const fileMap = new Map<number, typeof files>();
  for (const file of files) {
    const list = fileMap.get(file.share_id);
    if (list) list.push(file);
    else fileMap.set(file.share_id, [file]);
  }

  const exportFiles: ExportAttachment[] = files.map((file) => ({ id: String(file.id), name: String(file.name) }));
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const base = exportFileBase("学迹分享资料", shares.map((share) => share.title), stamp, "全部资料", "篇资料");
  const mdName = `${base}.md`;
  const md = buildShareMarkdown(
    me.name,
    shares.map((share) => ({ ...share, files: fileMap.get(share.id) ?? [] })),
    origin,
    "admin",
  );
  const zip = await packageExport(c.env, md, mdName, exportFiles);
  return c.body(zip, 200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="study-trail-shares-${stamp}.zip"; filename*=UTF-8''${encodeURIComponent(`${base}.zip`)}`,
    "Content-Length": String(zip.byteLength),
  });
});

adminRoutes.post("/shares", async (c) => {
  const t = parseShare(await c.req.json());
  const me = c.get("user");
  const db = c.env.DB;
  const row = await db
    .prepare(
      `INSERT INTO shares (title, description, tech_tags, status, audience_all, audience_mode, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(t.title, t.description, t.tech_tags, t.status, t.audience_all, t.audience_mode, me.id)
    .first<{ id: number }>();
  await db.batch([
    ...shareAudienceStatements(db, row!.id, t.class_ids, t.excluded_user_ids),
    audit(c, "发布资料", t.title),
  ]);
  if (t.file_ids.length) await bindShareFiles(c.env, me.id, row!.id, t.file_ids);
  if (t.status === "published" && t.notify) {
    const userIds = await shareAudienceUserIds(c.env, row!.id);
    await notifyShareUsers(c.env, userIds, `新资料：《${t.title}》`, row!.id);
  }
  return c.json({ share: row });
});

adminRoutes.get("/shares/:id", async (c) => {
  const id = int(c.req.param("id"), "资料ID")!;
  const db = c.env.DB;
  const [shareRes, filesRes, classRes, excludedRes] = await db.batch([
    db.prepare(
      `SELECT s.*, (SELECT u.name FROM users u WHERE u.id = s.created_by) AS creator_name,
              (SELECT a.id FROM avatars a WHERE a.user_id = s.created_by) AS creator_avatar_id,
              (SELECT GROUP_CONCAT(c.name, '、') FROM share_classes sc JOIN classes c ON c.id = sc.class_id WHERE sc.share_id = s.id) AS class_names
         FROM shares s WHERE s.id = ?`,
    ).bind(id),
    db.prepare("SELECT id, uploader_id, name, mime, size, created_at FROM files WHERE scope = 'share' AND share_id = ? ORDER BY created_at, id").bind(id),
    db.prepare("SELECT class_id FROM share_classes WHERE share_id = ? ORDER BY class_id").bind(id),
    db.prepare("SELECT user_id FROM share_exclusions WHERE share_id = ? ORDER BY user_id").bind(id),
  ]);
  if (!shareRes.results[0]) throw new HttpError(404, "资料不存在");
  return c.json({
    share: shareRes.results[0],
    files: filesRes.results,
    class_ids: (classRes.results as { class_id: number }[]).map((row) => row.class_id),
    excluded_user_ids: (excludedRes.results as { user_id: number }[]).map((row) => row.user_id),
  });
});

adminRoutes.put("/shares/:id", async (c) => {
  const id = int(c.req.param("id"), "资料ID")!;
  const t = parseShare(await c.req.json());
  const me = c.get("user");
  const db = c.env.DB;
  const previous = await db.prepare("SELECT id, status, title FROM shares WHERE id = ?").bind(id).first<{ id: number; status: string; title: string }>();
  if (!previous) throw new HttpError(404, "资料不存在");
  const oldAudience = previous.status === "published" ? new Set(await shareAudienceUserIds(c.env, id)) : new Set<number>();

  await db.batch([
    db
      .prepare(
        `UPDATE shares SET title = ?, description = ?, tech_tags = ?, status = ?, audience_all = ?, audience_mode = ?, updated_at = unixepoch(),
                pinned = CASE WHEN ? = 'archived' THEN 0 ELSE pinned END,
                pinned_at = CASE WHEN ? = 'archived' THEN NULL ELSE pinned_at END,
                pinned_by = CASE WHEN ? = 'archived' THEN NULL ELSE pinned_by END
          WHERE id = ?`,
      )
      .bind(t.title, t.description, t.tech_tags, t.status, t.audience_all, t.audience_mode, t.status, t.status, t.status, id),
    ...shareAudienceStatements(db, id, t.class_ids, t.excluded_user_ids),
    audit(c, "编辑资料", t.title),
  ]);
  if (t.remove_file_ids.length) await detachShareFiles(c.env, me.id, id, t.remove_file_ids);
  if (t.file_ids.length) await bindShareFiles(c.env, me.id, id, t.file_ids);
  if (t.status === "published" && t.notify) {
    const nextAudience = await shareAudienceUserIds(c.env, id);
    const fresh = nextAudience.filter((userId) => !oldAudience.has(userId));
    await notifyShareUsers(c.env, fresh, `新资料：《${t.title}》`, id);
  }
  return c.json({ ok: true });
});

adminRoutes.post("/shares/:id/pin", async (c) => {
  const id = int(c.req.param("id"), "资料ID")!;
  const body = await c.req.json();
  const pinned = body.pinned === true;
  const db = c.env.DB;
  const share = await db.prepare("SELECT id, title, pinned FROM shares WHERE id = ?").bind(id).first<{ id: number; title: string; pinned: number }>();
  if (!share) throw new HttpError(404, "资料不存在");

  if (pinned && !share.pinned) {
    const count = await db.prepare("SELECT COUNT(*) AS n FROM shares WHERE pinned = 1").first<{ n: number }>();
    if ((count?.n ?? 0) >= 5) throw new HttpError(400, "最多置顶 5 篇资料，请先取消其他置顶");
  }
  await db.batch([
    pinned
      ? db.prepare("UPDATE shares SET pinned = 1, pinned_at = unixepoch(), pinned_by = ?, updated_at = unixepoch() WHERE id = ?").bind(c.get("user").id, id)
      : db.prepare("UPDATE shares SET pinned = 0, pinned_at = NULL, pinned_by = NULL, updated_at = unixepoch() WHERE id = ?").bind(id),
    audit(c, pinned ? "置顶资料" : "取消置顶资料", share.title),
  ]);
  return c.json({ ok: true, pinned });
});

adminRoutes.post("/shares/batch-update", async (c) => {
  const body = await c.req.json();
  const ids = normalizeIdList(body.ids, "资料", 200);
  if (!ids.length) throw new HttpError(400, "请选择要操作的资料");
  const hasStatus = body.status !== undefined;
  if (hasStatus && !["draft", "published", "archived"].includes(String(body.status))) throw new HttpError(400, "资料状态无效");
  const addTags = tagList(body.add_tags);
  const removeTags = new Set(tagList(body.remove_tags).map((tag) => tag.toLowerCase()));
  if (!hasStatus && !addTags.length && !removeTags.size) throw new HttpError(400, "没有需要修改的内容");
  const status = hasStatus ? String(body.status) : undefined;
  const db = c.env.DB;
  let count = 0;

  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const placeholders = chunk.map(() => "?").join(", ");
    const { results } = await db
      .prepare(`SELECT id, tech_tags FROM shares WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all<{ id: number; tech_tags: string | null }>();
    const stmts: D1PreparedStatement[] = [];
    for (const row of results) {
      const sets: string[] = [];
      const binds: (string | number)[] = [];
      if (status) {
        sets.push("status = ?", "updated_at = unixepoch()");
        binds.push(status);
        if (status === "archived") sets.push("pinned = 0", "pinned_at = NULL", "pinned_by = NULL");
      }
      if (addTags.length || removeTags.size) {
        const kept = (row.tech_tags ?? "")
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean)
          .filter((tag) => !removeTags.has(tag.toLowerCase()));
        for (const tag of addTags) {
          if (!kept.some((old) => old.toLowerCase() === tag.toLowerCase())) kept.push(tag);
        }
        sets.push("tech_tags = ?", "updated_at = unixepoch()");
        binds.push(kept.slice(0, 12).join(","));
      }
      if (!sets.length) continue;
      binds.push(row.id);
      stmts.push(db.prepare(`UPDATE shares SET ${sets.join(", ")} WHERE id = ?`).bind(...binds));
    }
    if (stmts.length) await db.batch(stmts);
    count += results.length;
  }

  const actions = [
    hasStatus ? (status === "archived" ? "批量归档资料" : status === "published" ? "批量发布资料" : "批量转为草稿") : "",
    addTags.length ? "批量添加资料标签" : "",
    removeTags.size ? "批量移除资料标签" : "",
  ].filter(Boolean);
  await audit(c, actions.join(" · "), `${count} 篇资料`).run();
  return c.json({ ok: true, count });
});

adminRoutes.post("/shares/batch-delete", async (c) => {
  const body = await c.req.json();
  const ids = normalizeIdList(body.ids, "资料", 50);
  if (!ids.length) throw new HttpError(400, "请选择要删除的资料");
  const db = c.env.DB;
  const found: { id: number; title: string }[] = [];
  const keys: string[] = [];

  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const placeholders = chunk.map(() => "?").join(", ");
    const [sharesRes, filesRes] = await db.batch([
      db.prepare(`SELECT id, title FROM shares WHERE id IN (${placeholders})`).bind(...chunk),
      db.prepare(`SELECT r2_key FROM files WHERE share_id IN (${placeholders})`).bind(...chunk),
    ]);
    found.push(...(sharesRes.results as { id: number; title: string }[]));
    keys.push(...(filesRes.results as { r2_key: string }[]).map((row) => row.r2_key));
  }
  if (!found.length) throw new HttpError(404, "所选资料不存在");

  const existingIds = found.map((row) => row.id);
  for (let i = 0; i < existingIds.length; i += 90) {
    const chunk = existingIds.slice(i, i + 90);
    await db.prepare(`DELETE FROM shares WHERE id IN (${chunk.map(() => "?").join(", ")})`).bind(...chunk).run();
  }
  await deleteStoredObjects(c.env, keys);
  const titles = found.slice(0, 3).map((row) => row.title).join("、");
  await audit(c, "批量删除资料", `${found.length} 篇${found.length > 3 ? `：${titles} 等` : `：${titles}`}`).run();
  return c.json({ ok: true, count: found.length });
});

/** 任务标签 ∪ 资料标签，供资料编辑页推荐 */
adminRoutes.get("/share-tags", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT tech_tags FROM tasks WHERE tech_tags <> ''
     UNION ALL
     SELECT tech_tags FROM shares WHERE tech_tags <> ''`,
  ).all<{ tech_tags: string }>();
  const tags = new Map<string, number>();
  for (const row of results) {
    for (const tag of row.tech_tags.split(",").map((t) => t.trim()).filter(Boolean)) {
      tags.set(tag, (tags.get(tag) ?? 0) + 1);
    }
  }
  return c.json({ tags: [...tags.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)) });
});

/* ---------------- 督促学员 ---------------- */

adminRoutes.post("/tasks/:id/urge", async (c) => {
  const id = int(c.req.param("id"), "任务ID")!;
  const body = await c.req.json();
  const userIds = normalizeIdList(body.user_ids, "学员", 2000);
  if (!userIds.length) throw new HttpError(400, "请选择要督促的学员");
  const minutes = int(body.minutes, "倒计时", { min: 1, max: 60 * 24 * 30 })!;
  const message = str(body.message, "督促说明", { optional: true, max: 200 });

  const task = await c.env.DB.prepare("SELECT id, title FROM tasks WHERE id = ?")
    .bind(id)
    .first<{ id: number; title: string }>();
  if (!task) throw new HttpError(404, "任务不存在");

  const audience = new Set(await taskAudienceUserIds(c.env, id));
  const targets = userIds.filter((userId) => audience.has(userId));
  if (!targets.length) throw new HttpError(400, "所选学员不在该任务的发布范围内");

  const me = c.get("user");
  const dueAt = Math.floor(Date.now() / 1000) + minutes * 60;
  const link = `/app/tasks/${id}`;
  const title = message ? `辅导员督促你完成《${task.title}》：${message}` : `辅导员督促你尽快完成《${task.title}》`;
  for (let i = 0; i < targets.length; i += 25) {
    const chunk = targets.slice(i, i + 25);
    await c.env.DB.batch(
      chunk.flatMap((userId) => [
        c.env.DB.prepare("INSERT INTO task_urges (task_id, user_id, admin_id, message, due_at) VALUES (?, ?, ?, ?, ?)").bind(
          id,
          userId,
          me.id,
          message,
          dueAt,
        ),
        c.env.DB.prepare("INSERT INTO notifications (user_id, kind, title, link) VALUES (?, 'urge', ?, ?)").bind(userId, title, link),
      ]),
    );
  }
  await audit(c, "督促学员", `${task.title} · ${targets.length} 人 · ${minutes} 分钟`).run();
  return c.json({ count: targets.length, due_at: dueAt });
});

adminRoutes.delete("/tasks/:id/urge/:userId", async (c) => {
  const id = int(c.req.param("id"), "任务ID")!;
  const userId = int(c.req.param("userId"), "学员ID")!;
  await c.env.DB.prepare("DELETE FROM task_urges WHERE task_id = ? AND user_id = ?").bind(id, userId).run();
  await audit(c, "取消督促", `任务 #${id} · 学员 #${userId}`).run();
  return c.json({ ok: true });
});

/* ---------------- 全体通告 ---------------- */

adminRoutes.get("/announcement", async (c) => {
  const row = await c.env.DB.prepare("SELECT value, updated_at FROM app_settings WHERE key = 'announcement'")
    .first<{ value: string; updated_at: number }>();
  return c.json({ content: row?.value ?? "", updated_at: row?.updated_at ?? null });
});

adminRoutes.put("/announcement", async (c) => {
  const body = await c.req.json();
  const content = str(body.content, "通告内容", { optional: true, max: 20000 });
  if (content) {
    await c.env.DB.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('announcement', ?, unixepoch())
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
      .bind(content)
      .run();
  } else {
    await c.env.DB.prepare("DELETE FROM app_settings WHERE key = 'announcement'").run();
  }
  await audit(c, content ? "更新全体通告" : "清空全体通告", content ? `${content.length} 字` : "").run();
  const row = await c.env.DB.prepare("SELECT value, updated_at FROM app_settings WHERE key = 'announcement'")
    .first<{ value: string; updated_at: number }>();
  return c.json({ content: row?.value ?? "", updated_at: row?.updated_at ?? null });
});

/* ---------------- 审核 ---------------- */

adminRoutes.get("/reviews", async (c) => {
  const status = c.req.query("status") === "done" ? "done" : "pending";
  const where = status === "pending" ? "p.status = 'submitted'" : "p.status IN ('approved', 'rejected') AND p.reviewed_at IS NOT NULL";
  const { results } = await c.env.DB.prepare(
    `SELECT p.task_id, p.user_id, p.status, p.percent, p.note, p.link, p.review_comment, p.score, p.submitted_at, p.reviewed_at,
            u.name AS user_name, u.username, cl.name AS class_name, t.title AS task_title, t.tech_tags, r.name AS reviewer_name,
            (SELECT a.id FROM avatars a WHERE a.user_id = u.id) AS avatar_id,
            (SELECT a.id FROM avatars a WHERE a.user_id = p.reviewer_id) AS reviewer_avatar_id,
            (SELECT COUNT(*) FROM progress_events e WHERE e.task_id = p.task_id AND e.user_id = p.user_id AND e.action = 'submit') AS attempts,
            (SELECT COUNT(*) FROM files f WHERE f.scope = 'progress' AND f.task_id = p.task_id AND f.owner_user_id = p.user_id) AS file_count
       FROM progress p
       LEFT JOIN users r ON r.id = p.reviewer_id
       JOIN users u ON u.id = p.user_id
       JOIN tasks t ON t.id = p.task_id
       LEFT JOIN classes cl ON cl.id = u.class_id
      WHERE ${where}
      ORDER BY ${status === "pending" ? "p.submitted_at ASC" : "p.reviewed_at DESC"} LIMIT 200`,
  ).all();
  return c.json({ reviews: results });
});

adminRoutes.post("/reviews", async (c) => {
  const body = await c.req.json();
  const action = body.action === "reject" ? "rejected" : "approved";
  const comment = str(body.comment, "评语", { optional: true, max: 5000 });
  const score = action === "approved" ? (int(body.score, "评分", { min: 1, max: 5, optional: true }) ?? null) : null;
  const items: { task_id: number; user_id: number }[] = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
  if (items.length === 0) throw new HttpError(400, "请选择要审核的记录");
  if (action === "rejected" && !comment) throw new HttpError(400, "退回时请填写原因，方便学员修改");
  const fileIds = items.length === 1 ? normalizeFileIds(body.file_ids, MAX_REVIEW_FILES) : [];
  const me = c.get("user");
  const results = await c.env.DB.batch(
    items.map((it) =>
      c.env.DB.prepare(
        `UPDATE progress SET status = ?, review_comment = ?, score = ?, reviewer_id = ?, reviewed_at = unixepoch(), updated_at = unixepoch()
          WHERE task_id = ? AND user_id = ? AND status = 'submitted' RETURNING task_id`,
      ).bind(action, comment, score, me.id, int(it.task_id, "任务ID"), int(it.user_id, "学员ID")),
    ),
  );
  const updated = results.reduce((n, r) => n + r.results.length, 0);
  if (updated && fileIds.length && items.length === 1) {
    const item = items[0];
    const event = await c.env.DB.prepare(
      "SELECT id FROM progress_events WHERE task_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1",
    )
      .bind(item.task_id, item.user_id)
      .first<{ id: number }>();
    if (event) await bindReviewFiles(c.env, item.task_id, item.user_id, event.id, fileIds);
  }
  if (updated) await audit(c, action === "approved" ? "审核通过" : "审核退回", `${updated} 条提交`).run();
  return c.json({ updated });
});

adminRoutes.get("/progress/:taskId/:userId/events", async (c) => {
  const taskId = int(c.req.param("taskId"), "任务ID")!;
  const userId = int(c.req.param("userId"), "学员ID")!;
  const { results } = await c.env.DB.prepare(
    `SELECT e.id, e.action, e.comment, e.score, e.created_at, a.name AS actor_name,
            (SELECT av.id FROM avatars av WHERE av.user_id = e.actor_id) AS actor_avatar_id
       FROM progress_events e LEFT JOIN users a ON a.id = e.actor_id
      WHERE e.task_id = ? AND e.user_id = ? ORDER BY e.id DESC LIMIT 50`,
  )
    .bind(taskId, userId)
    .all();
  return c.json({ events: results });
});

adminRoutes.get("/progress/:taskId/:userId/files", async (c) => {
  const taskId = int(c.req.param("taskId"), "任务ID")!;
  const userId = int(c.req.param("userId"), "学员ID")!;
  const [progressFiles, reviewFiles] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT id, name, mime, size, created_at FROM files
        WHERE scope = 'progress' AND task_id = ? AND owner_user_id = ? ORDER BY created_at, id`,
    ).bind(taskId, userId),
    c.env.DB.prepare(
      `SELECT id, name, mime, size, created_at FROM files
        WHERE scope = 'review' AND task_id = ? AND owner_user_id = ? AND review_event_id IS NOT NULL
        ORDER BY created_at, id`,
    ).bind(taskId, userId),
  ]);
  return c.json({ files: progressFiles.results, reviewFiles: reviewFiles.results });
});

/* ---------------- 学习日志留言 / 答疑 ---------------- */

adminRoutes.get("/logs/:id/replies", async (c) => {
  const id = int(c.req.param("id"), "日志ID")!;
  const [repliesRes, filesRes] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT r.id, r.log_id, r.parent_id, r.content, r.created_at, r.user_id, u.name AS author_name, u.role AS author_role,
              (SELECT a.id FROM avatars a WHERE a.user_id = r.user_id) AS author_avatar_id
         FROM log_replies r JOIN users u ON u.id = r.user_id
        WHERE r.log_id = ? ORDER BY r.id`,
    ).bind(id),
    c.env.DB.prepare(
      `SELECT id, reply_id, name, mime, size, created_at FROM files
        WHERE scope = 'reply' AND log_id = ? ORDER BY created_at, id`,
    ).bind(id),
  ]);
  const fileMap = groupBy(filesRes.results as Record<string, unknown>[], "reply_id");
  return c.json({
    replies: (repliesRes.results as any[]).map((reply) => ({ ...reply, files: fileMap.get(reply.id) ?? [] })),
  });
});

adminRoutes.post("/logs/:id/replies", async (c) => {
  const id = int(c.req.param("id"), "日志ID")!;
  const body = await c.req.json();
  const content = str(body.content, "回复内容", { max: 2000, optional: true });
  const parentId = int(body.parent_id, "回复对象", { min: 1, optional: true });
  const hasFiles = Array.isArray(body.file_ids) && body.file_ids.length > 0;
  if (!content && !hasFiles) throw new HttpError(400, "回复内容不能为空");
  const log = await c.env.DB.prepare(
    `SELECT l.id, l.log_date, l.user_id, u.name AS user_name FROM study_logs l JOIN users u ON u.id = l.user_id WHERE l.id = ?`,
  )
    .bind(id)
    .first<{ id: number; log_date: string; user_id: number; user_name: string }>();
  if (!log) throw new HttpError(404, "日志不存在");
  if (parentId) {
    const parent = await c.env.DB.prepare("SELECT id FROM log_replies WHERE id = ? AND log_id = ?")
      .bind(parentId, id)
      .first();
    if (!parent) throw new HttpError(400, "要回复的留言不存在");
  }
  const me = c.get("user");
  const row = await c.env.DB.prepare(
    "INSERT INTO log_replies (log_id, user_id, parent_id, content) VALUES (?, ?, ?, ?) RETURNING id, created_at",
  )
    .bind(id, me.id, parentId, content)
    .first<{ id: number; created_at: number }>();
  try {
    await bindReplyFiles(c.env, id, row!.id, me.id, body.file_ids);
  } catch (err) {
    await c.env.DB.prepare("DELETE FROM log_replies WHERE id = ?").bind(row!.id).run();
    throw err;
  }
  const [avatar, files] = await Promise.all([
    c.env.DB.prepare("SELECT id FROM avatars WHERE user_id = ?").bind(me.id).first<{ id: string }>(),
    c.env.DB.prepare("SELECT id, name, mime, size, created_at FROM files WHERE scope = 'reply' AND reply_id = ? ORDER BY created_at, id")
      .bind(row!.id)
      .all(),
  ]);
  await audit(c, "回复学习日志", `${log.user_name} ${log.log_date}`).run();
  return c.json({
    reply: {
      ...row!,
      log_id: id,
      parent_id: parentId,
      content,
      user_id: me.id,
      author_name: me.name,
      author_role: me.role,
      author_avatar_id: avatar?.id ?? null,
      files: files.results,
    },
  });
});

/** 管理员编辑学员学习日志 */
adminRoutes.patch("/logs/:id", async (c) => {
  const id = int(c.req.param("id"), "日志ID")!;
  const body = await c.req.json();
  const content = str(body.content, "学习内容", { max: 10000 });
  const minutes = int(body.minutes, "学习时长", { min: 0, max: 1440 })!;
  const logDate = dateStr(body.log_date, "日期", false)!;
  const taskId = int(body.task_id, "关联任务", { min: 1, optional: true });

  const log = await c.env.DB.prepare("SELECT id, user_id, task_id FROM study_logs WHERE id = ?")
    .bind(id)
    .first<{ id: number; user_id: number; task_id: number | null }>();
  if (!log) throw new HttpError(404, "日志不存在");
  if (taskId && taskId !== log.task_id) {
    const visible = await c.env.DB.prepare(
      `SELECT t.id FROM tasks t JOIN users u ON u.id = ?
        WHERE t.id = ? AND t.status = 'published' AND ${audienceSql("t", "u")}`,
    )
      .bind(log.user_id, taskId)
      .first();
    if (!visible) throw new HttpError(400, "关联任务不存在或该学员不可见");
  }

  const row = await c.env.DB.prepare(
    "UPDATE study_logs SET content = ?, minutes = ?, log_date = ?, task_id = ? WHERE id = ? RETURNING id",
  )
    .bind(content, minutes, logDate, taskId, id)
    .first();
  if (!row) throw new HttpError(404, "日志不存在");
  const me = c.get("user");
  await detachLogFiles(c.env, log.user_id, id, body.remove_file_ids);
  await bindLogFiles(c.env, log.user_id, id, body.file_ids, me.id);
  await audit(c, "编辑学员日志", `#${id}`).run();
  return c.json({ log: row });
});

/** 管理员删除学员学习日志（同时删除附件） */
adminRoutes.delete("/logs/:id", async (c) => {
  const id = int(c.req.param("id"), "日志ID")!;
  const log = await c.env.DB.prepare("SELECT id, user_id, log_date FROM study_logs WHERE id = ?")
    .bind(id)
    .first<{ id: number; user_id: number; log_date: string }>();
  if (!log) throw new HttpError(404, "日志不存在");
  const keys = await fileKeysForLog(c.env, id);
  await c.env.DB.prepare("DELETE FROM study_logs WHERE id = ?").bind(id).run();
  await deleteStoredObjects(c.env, keys);
  await audit(c, "删除学员日志", `#${id} ${log.log_date}`).run();
  return c.json({ ok: true });
});

/* ---------------- 学习进度导出 ---------------- */

adminRoutes.get("/export", async (c) => {
  const me = c.get("user");
  const origin = new URL(c.req.url).origin;
  const ids = parseTaskIds(c.req.query("task_ids"));
  const legacyClassId = int(c.req.query("class_id"), "班级", { optional: true });
  const filterClassIds = parseIdList(c.req.query("class_ids"));
  const classIds = filterClassIds.length ? filterClassIds : legacyClassId ? [legacyClassId] : [];
  const userId = int(c.req.query("user_id"), "学员", { optional: true });
  const idFilter = ids.length ? ` AND t.id IN (${ids.map((_, i) => `?${i + 1}`).join(", ")})` : "";
  const tasksStmt = c.env.DB.prepare(
    `SELECT t.id, t.title, t.description, t.tech_tags, t.due_date, t.status, t.require_review,
            (SELECT GROUP_CONCAT(c.name, '、') FROM task_classes tc JOIN classes c ON c.id = tc.class_id WHERE tc.task_id = t.id) AS class_names
       FROM tasks t
      WHERE 1 = 1${idFilter}
      ORDER BY CASE t.status WHEN 'published' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, t.id DESC`,
  );
  const { results: tasks } = await (ids.length ? tasksStmt.bind(...ids) : tasksStmt).all<{
      id: number;
      title: string;
      description: string;
      tech_tags: string;
      due_date: string | null;
      status: string;
      require_review: number;
      class_names: string | null;
    }>();

  const taskIds = tasks.map((task) => task.id);
  let scopeLabel = userId ? `学员 #${userId}` : "全部学员";
  if (classIds.length) {
    const marks = classIds.map(() => "?").join(", ");
    const { results: classRows } = await c.env.DB.prepare(`SELECT id, name FROM classes WHERE id IN (${marks}) ORDER BY id`)
      .bind(...classIds)
      .all<{ id: number; name: string }>();
    scopeLabel = classRows.length ? `班级：${classRows.map((row) => row.name).join("、")}` : "班级范围";
  }
  if (!taskIds.length) {
    const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const base = exportFileBase("学迹学习任务", [], stamp, "全部任务", "个任务");
    const mdName = `${base}.md`;
    const zip = await packageExport(c.env, buildAdminMarkdown(me.name, [], scopeLabel, origin), mdName, []);
    return c.body(zip, 200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="study-trail-admin-${stamp}.zip"; filename*=UTF-8''${encodeURIComponent(`${base}.zip`)}`,
      "Content-Length": String(zip.byteLength),
    });
  }

  const inTasks = taskIds.map(() => "?").join(", ");
  const classIn = classIds.length ? `AND u.class_id IN (${classIds.map(() => "?").join(", ")})` : "";
  const rosterFilter = [classIn, userId ? "AND u.id = ?" : ""].filter(Boolean).join(" ");
  const rosterBinds = [...taskIds, ...classIds, ...(userId ? [userId] : [])];

  const [stepsRes, rosterRes, progressRes, filesRes, taskFilesRes, reviewFilesRes, logsRes, logFilesRes, repliesRes, replyFilesRes] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT task_id, title FROM task_steps WHERE task_id IN (${inTasks}) ORDER BY task_id, position, id`).bind(...taskIds),
    c.env.DB.prepare(
      `SELECT t.id AS task_id, u.id AS user_id, u.name, u.username, cl.name AS class_name
         FROM tasks t JOIN users u ON ${ELIGIBLE}
         LEFT JOIN classes cl ON cl.id = u.class_id
        WHERE t.id IN (${inTasks}) ${rosterFilter}
        ORDER BY t.id, u.id`,
    ).bind(...rosterBinds),
    c.env.DB.prepare(`SELECT * FROM progress WHERE task_id IN (${inTasks})`).bind(...taskIds),
    c.env.DB.prepare(
      `SELECT id, task_id, owner_user_id, name, mime, size FROM files
        WHERE scope = 'progress' AND task_id IN (${inTasks}) ORDER BY created_at, id`,
    ).bind(...taskIds),
    c.env.DB.prepare(
      `SELECT id, task_id, name, mime, size FROM files
        WHERE scope = 'task' AND task_id IN (${inTasks}) ORDER BY created_at, id`,
    ).bind(...taskIds),
    c.env.DB.prepare(
      `SELECT id, task_id, owner_user_id, name, mime, size FROM files
        WHERE scope = 'review' AND task_id IN (${inTasks}) AND review_event_id IS NOT NULL ORDER BY created_at, id`,
    ).bind(...taskIds),
    c.env.DB.prepare(
      `SELECT id, task_id, user_id, minutes, content, log_date FROM study_logs
        WHERE task_id IN (${inTasks}) ORDER BY log_date DESC, id DESC`,
    ).bind(...taskIds),
    c.env.DB.prepare(
      `SELECT f.id, f.log_id, f.name, f.mime, f.size
         FROM files f JOIN study_logs l ON l.id = f.log_id
        WHERE l.task_id IN (${inTasks}) AND f.reply_id IS NULL ORDER BY f.created_at, f.id`,
    ).bind(...taskIds),
    c.env.DB.prepare(
      `SELECT r.id, r.log_id, r.parent_id, r.content, r.created_at, r.user_id, u.name AS author_name, u.role AS author_role,
              (SELECT a.id FROM avatars a WHERE a.user_id = r.user_id) AS author_avatar_id
         FROM log_replies r JOIN users u ON u.id = r.user_id JOIN study_logs l ON l.id = r.log_id
        WHERE l.task_id IN (${inTasks}) ORDER BY r.id`,
    ).bind(...taskIds),
    c.env.DB.prepare(
      `SELECT f.id, f.reply_id, f.name, f.mime, f.size
         FROM files f JOIN study_logs l ON l.id = f.log_id
        WHERE l.task_id IN (${inTasks}) AND f.scope = 'reply' ORDER BY f.created_at, f.id`,
    ).bind(...taskIds),
  ]);

  const exportFiles: ExportAttachment[] = [
    ...(taskFilesRes.results as any[]),
    ...(filesRes.results as any[]),
    ...(reviewFilesRes.results as any[]),
    ...(logFilesRes.results as any[]),
    ...(replyFilesRes.results as any[]),
  ].map((file) => ({ id: String(file.id), name: String(file.name) }));

  const stepMap = groupBy(stepsRes.results as Record<string, unknown>[], "task_id");
  const rosterMap = groupBy(rosterRes.results as Record<string, unknown>[], "task_id");
  const progressMap = new Map((progressRes.results as any[]).map((row) => [`${row.task_id}:${row.user_id}`, row]));
  const fileMap = groupBy(filesRes.results as Record<string, unknown>[], "task_id");
  const taskFileMap = groupBy(taskFilesRes.results as Record<string, unknown>[], "task_id");
  const reviewFileMap = groupBy(reviewFilesRes.results as Record<string, unknown>[], "task_id");
  const logMap = groupBy(logsRes.results as Record<string, unknown>[], "task_id");
  const logFileMap = groupBy(logFilesRes.results as Record<string, unknown>[], "log_id");
  const replyMap = groupBy(repliesRes.results as Record<string, unknown>[], "log_id");
  const replyFileMap = groupBy(replyFilesRes.results as Record<string, unknown>[], "reply_id");

  const exportTasks = tasks.map((task) => {
    const roster = (rosterMap.get(task.id) ?? []) as any[];
    return {
      ...task,
      steps: (stepMap.get(task.id) ?? []) as any[],
      taskFiles: (taskFileMap.get(task.id) ?? []) as any[],
      rows: roster.map((student) => {
        const progress = progressMap.get(`${task.id}:${student.user_id}`) as any;
        const logs = ((logMap.get(task.id) ?? []) as any[])
          .filter((log) => log.user_id === student.user_id)
          .map((log) => ({
            ...log,
            files: (logFileMap.get(log.id) ?? []) as any,
            replies: ((replyMap.get(log.id) ?? []) as any[]).map((reply) => ({
              ...reply,
              files: replyFileMap.get(reply.id) ?? [],
            })),
          }));
        return {
          name: student.name,
          username: student.username,
          class_name: student.class_name,
          status: progress?.status ?? null,
          percent: progress?.percent ?? 0,
          note: progress?.note ?? null,
          link: progress?.link ?? null,
          review_comment: progress?.review_comment ?? null,
          score: progress?.score ?? null,
          submitted_at: progress?.submitted_at ?? null,
          reviewed_at: progress?.reviewed_at ?? null,
          files: ((fileMap.get(task.id) ?? []) as any[]).filter((file) => file.owner_user_id === student.user_id),
          review_files: ((reviewFileMap.get(task.id) ?? []) as any[]).filter((file) => file.owner_user_id === student.user_id),
          logs,
        };
      }),
    };
  });

  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const base = exportFileBase("学迹学习任务", tasks.map((task) => task.title), stamp, "全部任务", "个任务");
  const mdName = `${base}.md`;
  const zip = await packageExport(c.env, buildAdminMarkdown(me.name, exportTasks, scopeLabel, origin), mdName, exportFiles);
  return c.body(zip, 200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="study-trail-admin-${stamp}.zip"; filename*=UTF-8''${encodeURIComponent(`${base}.zip`)}`,
    "Content-Length": String(zip.byteLength),
  });
});

/* ---------------- 进度矩阵 ---------------- */

adminRoutes.get("/matrix", async (c) => {
  const legacyClassId = int(c.req.query("class_id"), "班级", { optional: true });
  const filterClassIds = parseIdList(c.req.query("class_ids"));
  const classIds = filterClassIds.length ? filterClassIds : legacyClassId ? [legacyClassId] : [];
  const filterTaskIds = parseIdList(c.req.query("task_ids"));
  const page = Math.max(1, int(c.req.query("page"), "页码", { optional: true, min: 1 }) ?? 1);
  const pageSize = Math.min(50, Math.max(10, int(c.req.query("pageSize"), "每页学员数", { optional: true, min: 10 }) ?? 30));
  const taskPage = Math.max(1, int(c.req.query("taskPage"), "任务页码", { optional: true, min: 1 }) ?? 1);
  const taskPageSize = Math.min(40, Math.max(5, int(c.req.query("taskPageSize"), "每页任务数", { optional: true, min: 5 }) ?? 15));
  const db = c.env.DB;
  const classMarks = classIds.map(() => "?").join(", ");
  const classFilter = classIds.length ? `AND u.class_id IN (${classMarks})` : "";
  const taskFilter = classIds.length
    ? `AND (NOT EXISTS (SELECT 1 FROM task_classes tc WHERE tc.task_id = t.id) OR EXISTS (SELECT 1 FROM task_classes tc WHERE tc.task_id = t.id AND tc.class_id IN (${classMarks})))`
    : "";
  const taskIdFilter = filterTaskIds.length ? `AND t.id IN (${filterTaskIds.map(() => "?").join(", ")})` : "";
  const studentBinds = classIds;
  const taskBinds = [...classIds, ...filterTaskIds];

  // 学员、任务均分页加载，避免默认把全部学员 × 全部任务一次性返回。
  const [studentsRes, studentCountRes, tasksRes, taskCountRes, taskOptionsRes] = await db.batch([
    db
      .prepare(
        `SELECT u.id, u.name, u.class_id FROM users u
          WHERE u.role = 'student' AND u.active = 1 ${classFilter}
          ORDER BY u.class_id, u.id LIMIT ? OFFSET ?`,
      )
      .bind(...studentBinds, pageSize, (page - 1) * pageSize),
    db.prepare(`SELECT COUNT(*) AS total FROM users u WHERE u.role = 'student' AND u.active = 1 ${classFilter}`).bind(...studentBinds),
    db
      .prepare(
        `SELECT t.id, t.title, t.class_id, t.due_date,
                (SELECT GROUP_CONCAT(class_id) FROM task_classes WHERE task_id = t.id) AS class_ids,
                (SELECT GROUP_CONCAT(user_id) FROM task_exclusions WHERE task_id = t.id) AS excluded_user_ids
           FROM tasks t WHERE t.status = 'published' ${taskFilter} ${taskIdFilter}
          ORDER BY t.id LIMIT ? OFFSET ?`,
      )
      .bind(...taskBinds, taskPageSize, (taskPage - 1) * taskPageSize),
    db.prepare(`SELECT COUNT(*) AS total FROM tasks t WHERE t.status = 'published' ${taskFilter} ${taskIdFilter}`).bind(...taskBinds),
    // 筛选下拉使用：当前班级范围内全部已发布任务，不受已选任务过滤影响
    db.prepare(`SELECT t.id, t.title FROM tasks t WHERE t.status = 'published' ${taskFilter} ORDER BY t.id`).bind(...studentBinds),
  ]);

  const students = studentsRes.results as { id: number; name: string; class_id: number | null }[];
  const taskOptions = taskOptionsRes.results as { id: number; title: string }[];
  const tasks = (tasksRes.results as any[]).map((task) => ({
    ...task,
    class_ids: task.class_ids ? String(task.class_ids).split(",").map(Number) : [],
    excluded_user_ids: task.excluded_user_ids ? String(task.excluded_user_ids).split(",").map(Number) : [],
  }));
  const studentIds = students.map((s) => s.id);
  const taskIds = tasks.map((t) => t.id);

  const cells: { task_id: number; user_id: number; status: string; percent: number }[] = [];
  for (let i = 0; i < studentIds.length; i += 40) {
    for (let j = 0; j < taskIds.length; j += 40) {
      const userChunk = studentIds.slice(i, i + 40);
      const taskChunk = taskIds.slice(j, j + 40);
      if (!userChunk.length || !taskChunk.length) continue;
      const { results } = await db
        .prepare(
          `SELECT task_id, user_id, status, percent FROM progress
            WHERE task_id IN (${taskChunk.map(() => "?").join(", ")})
              AND user_id IN (${userChunk.map(() => "?").join(", ")})`,
        )
        .bind(...taskChunk, ...userChunk)
        .all<{ task_id: number; user_id: number; status: string; percent: number }>();
      cells.push(...results);
    }
  }

  return c.json({
    students,
    tasks,
    taskOptions,
    cells,
    studentTotal: Number((studentCountRes.results[0] as { total: number } | undefined)?.total ?? 0),
    taskTotal: Number((taskCountRes.results[0] as { total: number } | undefined)?.total ?? 0),
    page,
    pageSize,
    taskPage,
    taskPageSize,
  });
});
