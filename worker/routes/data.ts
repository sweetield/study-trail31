import { Hono } from "hono";
import type { AppEnv } from "../types";
import { requireAuth, requireSuperAdmin } from "../lib/session";
import { verifyPassword } from "../lib/crypto";
import { HttpError, dateStr, int } from "../lib/validate";
import { audit } from "../lib/audit";
import {
  availableStorageBackends,
  deleteStoredObjects,
  getStoredObject,
  putStoredObject,
  resetEncryptionKeyCache,
  storageBackend,
  type StorageBackend,
} from "../lib/storage";
import { createZip, readZip } from "../lib/zip";

export const dataRoutes = new Hono<AppEnv>();
dataRoutes.use("*", requireAuth, requireSuperAdmin);

const BACKUP_FORMAT = "xueji-backup";
const BACKUP_VERSION = 5;
const FULL_BACKUP_VERSION = 6;
const LEGACY_VERSIONS = new Set([2, 3, 4, 5]);
const MAX_ROWS = 200_000;
const MAX_FULL_BACKUP_BYTES = 90 * 1024 * 1024;
// 7z / tar 压缩包（含 .001 分卷）体积大且通常可重新获取：超过 1 MB 的不写入完整备份，
// 小于 1 MB 的小压缩包随备份一起保留，避免重新部署后需要逐个补传
const ARCHIVE_ATTACHMENT_EXT = /\.(7z|tar)(\.\d{3})?$/i;
const ARCHIVE_ATTACHMENT_MIME = /^application\/(x-7z-compressed|x-tar)$/i;
const MAX_BACKUP_ARCHIVE_BYTES = 1024 * 1024;

// v4 及更早版本备份的字段。旧备份仍按旧字段恢复，新增字段交给数据库默认值。
// 按外键依赖顺序排列：插入时正序，删除时倒序
const V4_TABLES = {
  classes: ["id", "name", "created_at"],
  users: [
    "id", "username", "name", "password_hash", "role", "class_id", "active",
    "must_change_password", "failed_attempts", "locked_until", "last_login_at", "created_at",
  ],
  tasks: ["id", "title", "description", "tech_tags", "class_id", "due_date", "status", "require_review", "created_at", "updated_at"],
  task_classes: ["task_id", "class_id"],
  task_exclusions: ["task_id", "user_id"],
  task_steps: ["id", "task_id", "title", "position"],
  progress: [
    "task_id", "user_id", "status", "percent", "note", "link", "review_comment", "score", "reviewer_id",
    "submitted_at", "reviewed_at", "updated_at",
  ],
  step_checks: ["user_id", "step_id", "task_id", "checked_at"],
  study_logs: ["id", "user_id", "task_id", "minutes", "content", "log_date", "created_at"],
  log_replies: ["id", "log_id", "user_id", "content", "created_at"],
  progress_events: ["id", "task_id", "user_id", "action", "comment", "score", "actor_id", "created_at"],
} as const satisfies Record<string, readonly string[]>;

// v5 起完整导出所有文字类业务数据（不含附件与头像内容）
const TABLES = {
  classes: V4_TABLES.classes,
  users: [...V4_TABLES.users, "announcement_seen_at", "announcement_seen_login_at", "is_super_admin"],
  tasks: [...V4_TABLES.tasks, "priority", "pinned", "pinned_at", "pinned_by", "created_by"],
  task_classes: V4_TABLES.task_classes,
  task_exclusions: V4_TABLES.task_exclusions,
  task_steps: V4_TABLES.task_steps,
  progress: V4_TABLES.progress,
  step_checks: V4_TABLES.step_checks,
  study_logs: V4_TABLES.study_logs,
  log_replies: [...V4_TABLES.log_replies, "parent_id"],
  progress_events: V4_TABLES.progress_events,
  notifications: ["id", "user_id", "kind", "title", "link", "read_at", "created_at"],
  task_urges: ["id", "task_id", "user_id", "admin_id", "message", "due_at", "created_at"],
  audit_logs: ["id", "actor_id", "actor_name", "action", "target", "ip", "created_at"],
  app_settings: ["key", "value", "updated_at"],
  shares: [
    "id", "title", "description", "tech_tags", "status", "audience_all", "pinned", "pinned_at", "pinned_by",
    "view_count", "created_by", "created_at", "updated_at",
  ],
  share_classes: ["share_id", "class_id"],
  share_exclusions: ["share_id", "user_id"],
  share_views: ["share_id", "user_id", "viewed_at"],
} as const satisfies Record<string, readonly string[]>;

// 完整备份额外包含附件与头像的元数据；文件内容以原始密文写入 ZIP 的 objects/ 目录
const ASSET_TABLES = {
  files: [
    "id", "uploader_id", "owner_user_id", "scope", "log_id", "task_id", "share_id", "reply_id", "review_event_id",
    "name", "mime", "size", "iv", "r2_key", "created_at",
  ],
  avatars: ["user_id", "id", "name", "mime", "size", "iv", "storage_key", "created_at"],
} as const satisfies Record<string, readonly string[]>;

type Cell = string | number | null;

dataRoutes.get("/status", async (c) => {
  const results = await c.env.DB.batch<{ n: number }>([
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM classes"),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'student'"),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM tasks"),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM progress"),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM study_logs"),
  ]);
  const [classes, students, tasks, progress, logs] = results.map((row) => Number(row.results[0]?.n ?? 0));
  const available = availableStorageBackends(c.env);
  let current: StorageBackend = available.includes("r2") ? "r2" : "kv";
  try {
    current = await storageBackend(c.env);
  } catch {
    // 未绑定存储时仍然可以导出/导入文字数据
  }
  return c.json({
    // 全新初始化（或旧数据未导入）时提示管理员恢复备份
    empty: students === 0 && tasks === 0,
    counts: { classes, students, tasks, progress, logs },
    storage: { available, current },
  });
});

/* ---------------- 学期归档（可选） ---------------- */

/** 归档前预览：指定日期之前的日志、留言附件数量与体积 */
dataRoutes.get("/archive", async (c) => {
  const before = dateStr(c.req.query("before"), "归档日期", false)!;
  const [logsRes, filesRes] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT COUNT(*) AS n, MIN(log_date) AS oldest FROM study_logs WHERE log_date < ?").bind(before),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(f.size), 0) AS bytes
         FROM files f JOIN study_logs l ON l.id = f.log_id
        WHERE l.log_date < ?`,
    ).bind(before),
  ]);
  const logsRow = logsRes.results[0] as { n: number; oldest: string | null } | undefined;
  const filesRow = filesRes.results[0] as { n: number; bytes: number } | undefined;
  return c.json({
    before,
    logs: Number(logsRow?.n ?? 0),
    oldest: logsRow?.oldest ?? null,
    files: Number(filesRow?.n ?? 0),
    bytes: Number(filesRow?.bytes ?? 0),
  });
});

/**
 * 按日期删除旧日志（连同留言与附件）。每次最多处理 50 条，返回 remaining，
 * 前端可循环调用，避免单次请求时间过长或一次写入过多行。
 */
dataRoutes.post("/archive", async (c) => {
  const body = await c.req.json();
  const before = dateStr(body.before, "归档日期", false)!;
  if (body.confirm !== "归档") throw new HttpError(400, "请输入「归档」确认操作");
  const minAllowed = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  if (before > minAllowed) throw new HttpError(400, `为保留最近 30 天的记录，归档日期不能晚于 ${minAllowed}`);

  // D1 单条 SQL 最多绑定 100 个参数，留出余量按 50 条一批处理
  const limit = Math.min(100, Math.max(1, int(body.limit, "单次数量", { optional: true, min: 1 }) ?? 50));
  const db = c.env.DB;
  const { results: rows } = await db
    .prepare("SELECT id FROM study_logs WHERE log_date < ? ORDER BY log_date, id LIMIT ?")
    .bind(before, limit)
    .all<{ id: number }>();
  const ids = rows.map((row) => row.id);
  if (!ids.length) return c.json({ deleted_logs: 0, deleted_files: 0, remaining: 0 });

  const marks = ids.map(() => "?").join(", ");
  const { results: files } = await db
    .prepare(`SELECT r2_key FROM files WHERE log_id IN (${marks})`)
    .bind(...ids)
    .all<{ r2_key: string }>();

  // 删除日志会级联删除留言与附件元数据，并由数据库触发器清理相关通知
  await db.batch([
    db.prepare(`DELETE FROM study_logs WHERE id IN (${marks})`).bind(...ids),
    audit(c, "学期归档", `${before} 之前 ${ids.length} 条日志`),
  ]);
  await deleteStoredObjects(c.env, files.map((file) => file.r2_key));

  const rest = await db.prepare("SELECT COUNT(*) AS n FROM study_logs WHERE log_date < ?").bind(before).first<{ n: number }>();
  return c.json({ deleted_logs: ids.length, deleted_files: files.length, remaining: Number(rest?.n ?? 0) });
});

dataRoutes.get("/export", async (c) => {
  const tableNames = Object.keys(TABLES) as (keyof typeof TABLES)[];
  const results = await c.env.DB.batch(
    tableNames.map((t) => c.env.DB.prepare(`SELECT ${TABLES[t].join(", ")} FROM ${t} ORDER BY rowid`)),
  );
  const tables = Object.fromEntries(tableNames.map((t, i) => [t, results[i].results]));
  await audit(c, "导出数据备份").run();
  const now = new Date();
  const stamp = now.toISOString().slice(0, 10).replaceAll("-", "");
  c.header("Content-Disposition", `attachment; filename="xueji-backup-${stamp}.json"`);
  return c.json({ format: BACKUP_FORMAT, version: BACKUP_VERSION, exported_at: now.toISOString(), tables });
});

/** 判断附件是否为 7z / tar 压缩包（文件名或 MIME 任一匹配） */
function isArchiveAttachment(row: Record<string, unknown>): boolean {
  const name = typeof row.name === "string" ? row.name : "";
  const mime = typeof row.mime === "string" ? row.mime : "";
  return ARCHIVE_ATTACHMENT_EXT.test(name) || ARCHIVE_ATTACHMENT_MIME.test(mime);
}

/** 只有超过 1 MB 的压缩包才跳过；大小未知时按超限处理，避免备份体积失控 */
function shouldSkipArchiveAttachment(row: Record<string, unknown>): boolean {
  if (!isArchiveAttachment(row)) return false;
  const size = typeof row.size === "number" ? row.size : Number(row.size);
  return !Number.isFinite(size) || size >= MAX_BACKUP_ARCHIVE_BYTES;
}

/**
 * 完整备份导出：全部文字数据 + 附件 / 头像的原始密文。
 * 超过 1 MB 的 7z / tar 压缩包附件及其元数据会被跳过；小于 1 MB 的小压缩包正常打包。
 * 文字数据请使用 /export（JSON），避免与此接口产生重复。
 */
dataRoutes.get("/export-full", async (c) => {
  const columnsByName: Record<string, readonly string[]> = { ...TABLES, ...ASSET_TABLES };
  const tableNames = Object.keys(columnsByName);
  const results = await c.env.DB.batch(
    tableNames.map((t) => c.env.DB.prepare(`SELECT ${columnsByName[t].join(", ")} FROM ${t} ORDER BY rowid`)),
  );
  const tables = Object.fromEntries(tableNames.map((t, i) => [t, results[i].results]));

  // 超过 1 MB 的压缩包附件不进入备份：元数据与对象一起跳过，恢复时才不会因缺少对象而失败
  const allFiles = (tables.files ?? []) as Record<string, unknown>[];
  const files = allFiles.filter((row) => !shouldSkipArchiveAttachment(row));
  const skippedArchives = allFiles.length - files.length;
  tables.files = files;

  const keys = new Set<string>();
  for (const row of (tables.files ?? []) as { r2_key: string }[]) if (row.r2_key) keys.add(row.r2_key);
  for (const row of (tables.avatars ?? []) as { storage_key: string }[]) if (row.storage_key) keys.add(row.storage_key);

  const entries: { name: string; data: Uint8Array }[] = [];
  let missing = 0;
  if (availableStorageBackends(c.env).length) {
    for (const key of keys) {
      try {
        const object = await getStoredObject(c.env, key);
        if (object) entries.push({ name: `objects/${key}`, data: new Uint8Array(object) });
        else missing += 1;
      } catch (err) {
        console.error("read stored object for backup failed", key, err);
        missing += 1;
      }
    }
  } else {
    // 没有绑定文件存储时仍可导出文字数据，但附件内容无法读取
    missing = keys.size;
  }

  const now = new Date();
  const backup = {
    format: BACKUP_FORMAT,
    version: FULL_BACKUP_VERSION,
    exported_at: now.toISOString(),
    assets_included: true,
    missing_objects: missing,
    skipped_archives: skippedArchives,
    tables,
  };
  const zip = createZip([
    { name: "backup.json", data: new TextEncoder().encode(JSON.stringify(backup)) },
    ...entries,
  ]);
  const count = Object.values(tables).reduce((sum, rows) => sum + rows.length, 0);
  await audit(
    c,
    "导出完整数据备份",
    `${count} 条记录 · ${entries.length} 个文件${skippedArchives ? ` · 跳过 ${skippedArchives} 个超过 1 MB 的压缩包` : ""}${missing ? ` · ${missing} 个文件缺失` : ""}`,
  ).run();
  const stamp = now.toISOString().slice(0, 10).replaceAll("-", "");
  return c.body(zip, 200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="xueji-full-backup-${stamp}.zip"`,
    "Content-Length": String(zip.byteLength),
    "X-Backup-Skipped-Archives": String(skippedArchives),
    "Cache-Control": "no-store",
  });
});

function isFile(value: unknown): value is File {
  return !!value && typeof value === "object" && typeof (value as File).arrayBuffer === "function" && typeof (value as File).name === "string";
}

function readRows(tables: Record<string, unknown>, name: string, columns: readonly string[]): Cell[][] {
  const raw = tables[name] ?? [];
  if (!Array.isArray(raw)) throw new HttpError(400, `备份文件中的 ${name} 数据格式错误`);
  return raw.map((row) => {
    if (!row || typeof row !== "object") throw new HttpError(400, `备份文件中的 ${name} 数据格式错误`);
    return columns.map((col) => {
      let value = (row as Record<string, unknown>)[col];
      // 旧版完整备份没有任务置顶字段，按未置顶恢复，避免 NOT NULL 约束导致恢复失败
      if ((value === undefined || value === null) && name === "tasks" && col === "pinned") value = 0;
      if (value === undefined || value === null) return null;
      if (typeof value === "string" || typeof value === "number") return value;
      if (typeof value === "boolean") return value ? 1 : 0;
      throw new HttpError(400, `备份文件中的 ${name}.${col} 数据格式错误`);
    });
  });
}

function assertHasAdmin(data: Record<string, Cell[][]>, columns: Record<string, readonly string[]>) {
  const roleIdx = columns.users.indexOf("role");
  const activeIdx = columns.users.indexOf("active");
  if (!data.users.some((u) => u[roleIdx] === "admin" && Number(u[activeIdx]) === 1)) {
    throw new HttpError(400, "备份中没有可用的管理员账号，恢复后将无法登录，已取消");
  }
}

/**
 * 用备份内容替换全部业务数据。D1 batch 在单个事务中执行，任一语句失败会整体回滚。
 */
async function replaceData(
  db: D1Database,
  columnsByName: Record<string, readonly string[]>,
  tableNames: string[],
  data: Record<string, Cell[][]>,
  version: number,
) {
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM sessions"),
    db.prepare("DELETE FROM notifications"),
    // v2/v3 备份不包含发布范围表，先无条件清空，避免旧班级/排除名单残留
    db.prepare("DELETE FROM task_exclusions"),
    db.prepare("DELETE FROM task_classes"),
    ...[...tableNames].reverse().map((t) => db.prepare(`DELETE FROM ${t}`)),
  ];
  for (const t of tableNames) {
    // 插入任务与进度会触发通知和历史触发器，恢复时需清掉这些副作用后再写入备份中的历史
    if (t === "progress_events") statements.push(db.prepare("DELETE FROM notifications"), db.prepare("DELETE FROM progress_events"));
    const columns = columnsByName[t];
    const insert = db.prepare(`INSERT INTO ${t} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
    for (const row of data[t]) statements.push(insert.bind(...row));
  }
  // 旧版本备份只有 tasks.class_id，恢复后补齐新的发布范围表
  if (version < 4) {
    statements.push(
      db.prepare("INSERT OR IGNORE INTO task_classes (task_id, class_id) SELECT id, class_id FROM tasks WHERE class_id IS NOT NULL"),
    );
  }
  // 旧备份不含管理员分级字段：恢复后至少保证有一个可用的管理员账号
  if (tableNames.includes("users")) {
    statements.push(
      db.prepare(
        `UPDATE users SET is_super_admin = 1
          WHERE id = (SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1)
            AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin' AND active = 1 AND is_super_admin = 1)`,
      ),
    );
  }
  await db.batch(statements);
}

dataRoutes.post("/import", async (c) => {
  const body = await c.req.json<{ password?: unknown; backup?: unknown }>();
  const me = c.get("user");

  const current = await c.env.DB.prepare("SELECT password_hash FROM users WHERE id = ?").bind(me.id).first<{ password_hash: string }>();
  if (!current || typeof body.password !== "string" || !(await verifyPassword(body.password, current.password_hash))) {
    throw new HttpError(403, "当前管理员密码错误");
  }

  const backup = body.backup as { format?: unknown; version?: unknown; tables?: unknown } | null;
  if (!backup || backup.format !== BACKUP_FORMAT || typeof backup.tables !== "object" || !backup.tables) {
    throw new HttpError(400, "不是有效的学迹备份文件");
  }
  if (typeof backup.version !== "number" || !LEGACY_VERSIONS.has(backup.version)) {
    throw new HttpError(400, "备份文件版本不受支持");
  }
  const version = backup.version;

  // v2 没有 log_replies；v2/v3 没有任务发布范围表；v5 起完整导出所有文字记录
  const columnsByName: Record<string, readonly string[]> = version >= 5 ? TABLES : V4_TABLES;
  let tableNames = Object.keys(columnsByName);
  if (version < 4) tableNames = tableNames.filter((t) => t !== "task_classes" && t !== "task_exclusions");
  if (version < 3) tableNames = tableNames.filter((t) => t !== "log_replies");

  const tables = backup.tables as Record<string, unknown>;
  const data = Object.fromEntries(tableNames.map((t) => [t, readRows(tables, t, columnsByName[t])])) as Record<string, Cell[][]>;

  const total = tableNames.reduce((sum, t) => sum + data[t].length, 0);
  if (total > MAX_ROWS) throw new HttpError(400, "备份数据量过大");

  assertHasAdmin(data, columnsByName);

  const db = c.env.DB;
  // 备份可能包含 app_settings，其中 file_storage 会改变存储后端；先记住旧数据所在的存储
  let oldBackend: StorageBackend | undefined;
  try {
    oldBackend = await storageBackend(c.env);
  } catch {
    // 未绑定存储时没有需要清理的文件对象
  }
  // 存储类型由当前部署的绑定决定，恢复时不沿用备份中的切换记录
  if (columnsByName.app_settings) {
    const settingKeyIndex = columnsByName.app_settings.indexOf("key");
    data.app_settings = data.app_settings.filter((row) => row[settingKeyIndex] !== "file_storage");
    if (oldBackend) data.app_settings.push(["file_storage", oldBackend, Math.floor(Date.now() / 1000)]);
  }
  // 备份不包含附件与头像内容；恢复会清空对应元数据表，先记下旧对象 key 以便清理
  const [oldFiles, oldAvatars] = await db.batch([
    db.prepare("SELECT r2_key FROM files"),
    db.prepare("SELECT storage_key FROM avatars"),
  ]);
  const staleKeys = [
    ...(oldFiles.results as { r2_key: string }[]).map((row) => row.r2_key),
    ...(oldAvatars.results as { storage_key: string }[]).map((row) => row.storage_key),
  ];

  try {
    await replaceData(db, columnsByName, tableNames, data, version);
  } catch (err) {
    console.error(err);
    throw new HttpError(400, "备份数据不完整或存在冲突，恢复失败，原有数据未改动");
  }

  // 恢复后 app_settings 中的加密密钥可能已变化，清除内存缓存
  resetEncryptionKeyCache();

  // 数据库已切换为新数据，旧附件/头像对象不再被引用，删除以释放存储空间
  if (staleKeys.length) {
    try {
      await deleteStoredObjects(c.env, staleKeys, oldBackend);
    } catch (err) {
      console.error("cleanup stored objects after restore failed", err);
    }
  }

  await audit(c, "从备份恢复数据", `共 ${total} 条记录`, { id: null, name: me.name }).run();
  const counts = Object.fromEntries(tableNames.map((t) => [t, data[t].length]));
  return c.json({ ok: true, counts });
});

/** 从完整备份 ZIP 恢复：文字数据、附件与头像一起恢复 */
dataRoutes.post("/import-full", async (c) => {
  const me = c.get("user");
  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    throw new HttpError(400, "备份数据格式不正确");
  }

  const current = await c.env.DB.prepare("SELECT password_hash FROM users WHERE id = ?").bind(me.id).first<{ password_hash: string }>();
  const password = String(form.get("password") ?? "");
  if (!current || !(await verifyPassword(password, current.password_hash))) {
    throw new HttpError(403, "当前管理员密码错误");
  }

  const file = form.get("file");
  if (!isFile(file)) throw new HttpError(400, "请选择完整备份 ZIP 文件");
  if (!file.size) throw new HttpError(400, "备份文件为空");
  if (file.size > MAX_FULL_BACKUP_BYTES) throw new HttpError(400, `完整备份不能超过 ${MAX_FULL_BACKUP_BYTES / 1024 / 1024} MB`);

  let entries: Map<string, Uint8Array>;
  try {
    entries = readZip(new Uint8Array(await file.arrayBuffer()));
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : "无法读取 ZIP 备份文件");
  }

  const jsonEntry = entries.get("backup.json");
  if (!jsonEntry) throw new HttpError(400, "ZIP 中缺少 backup.json");
  let backup: { format?: unknown; version?: unknown; tables?: unknown; assets_included?: unknown };
  try {
    backup = JSON.parse(new TextDecoder().decode(jsonEntry)) as { format?: unknown; version?: unknown; tables?: unknown; assets_included?: unknown };
  } catch {
    throw new HttpError(400, "backup.json 不是有效的 JSON");
  }
  if (backup.format !== BACKUP_FORMAT || backup.version !== FULL_BACKUP_VERSION || typeof backup.tables !== "object" || !backup.tables) {
    throw new HttpError(400, "不是有效的学迹完整备份文件");
  }

  const columnsByName: Record<string, readonly string[]> = { ...TABLES, ...ASSET_TABLES };
  const tableNames = Object.keys(columnsByName);
  const tables = backup.tables as Record<string, unknown>;
  const data = Object.fromEntries(tableNames.map((t) => [t, readRows(tables, t, columnsByName[t])])) as Record<string, Cell[][]>;

  const total = tableNames.reduce((sum, t) => sum + data[t].length, 0);
  if (total > MAX_ROWS) throw new HttpError(400, "备份数据量过大");
  assertHasAdmin(data, columnsByName);

  const db = c.env.DB;
  const [oldFiles, oldAvatars] = await db.batch([
    db.prepare("SELECT r2_key FROM files"),
    db.prepare("SELECT storage_key FROM avatars"),
  ]);
  const oldKeys = new Set([
    ...(oldFiles.results as { r2_key: string }[]).map((row) => row.r2_key),
    ...(oldAvatars.results as { storage_key: string }[]).map((row) => row.storage_key),
  ]);

  const fileKeyIndex = columnsByName.files.indexOf("r2_key");
  const avatarKeyIndex = columnsByName.avatars.indexOf("storage_key");
  const newKeys = [
    ...data.files.map((row) => String(row[fileKeyIndex])),
    ...data.avatars.map((row) => String(row[avatarKeyIndex])),
  ];
  const missing = newKeys.filter((key) => !entries.has(`objects/${key}`));
  if (missing.length) {
    throw new HttpError(400, `备份缺少 ${missing.length} 个附件或头像内容，无法完整恢复；请重新导出完整备份`);
  }

  const available = availableStorageBackends(c.env);
  if (newKeys.length && !available.length) throw new HttpError(400, "当前部署未绑定 R2 或 KV，无法恢复附件与头像");
  // 文字备份不含附件，不需要绑定文件存储也能恢复；有附件时沿用当前部署的存储
  const targetBackend = available.length ? await storageBackend(c.env) : undefined;

  // 先把附件写入当前部署实际使用的存储，避免恢复 app_settings 后指向不可用的存储
  const written: string[] = [];
  try {
    for (const key of newKeys) {
      const bytes = entries.get(`objects/${key}`)!.slice();
      await putStoredObject(c.env, key, bytes.buffer as ArrayBuffer, targetBackend);
      written.push(key);
    }
  } catch (err) {
    console.error(err);
    await deleteStoredObjects(c.env, written.filter((key) => !oldKeys.has(key)), targetBackend);
    throw new HttpError(400, "写入附件失败，当前数据未改动");
  }

  // file_storage 是部署相关配置，恢复时沿用当前部署实际绑定的存储
  const settingKeyIndex = columnsByName.app_settings.indexOf("key");
  data.app_settings = data.app_settings.filter((row) => row[settingKeyIndex] !== "file_storage");
  if (targetBackend) data.app_settings.push(["file_storage", targetBackend, Math.floor(Date.now() / 1000)]);

  try {
    await replaceData(db, columnsByName, tableNames, data, FULL_BACKUP_VERSION);
  } catch (err) {
    console.error(err);
    await deleteStoredObjects(c.env, written.filter((key) => !oldKeys.has(key)), targetBackend);
    throw new HttpError(400, "备份数据不完整或存在冲突，恢复失败，原有数据未改动");
  }

  // 恢复后 app_settings 中的加密密钥可能已变化，清除内存缓存
  resetEncryptionKeyCache();

  const staleKeys = [...oldKeys].filter((key) => !newKeys.includes(key));
  if (staleKeys.length && targetBackend) {
    try {
      await deleteStoredObjects(c.env, staleKeys, targetBackend);
    } catch (err) {
      console.error("cleanup stored objects after full restore failed", err);
    }
  }

  await audit(
    c,
    newKeys.length ? "从完整备份恢复数据" : "从文字备份恢复数据",
    newKeys.length ? `共 ${total} 条记录 · ${newKeys.length} 个文件` : `共 ${total} 条记录 · 不含附件与头像`,
    { id: null, name: me.name },
  ).run();
  const counts = Object.fromEntries(tableNames.map((t) => [t, data[t].length]));
  return c.json({ ok: true, counts, files: newKeys.length });
});
