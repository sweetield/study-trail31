import { Hono } from "hono";
import type { AppEnv, Env, SessionUser } from "../types";
import { requireAuth } from "../lib/session";
import { HttpError, int } from "../lib/validate";
import { assertPendingScopeQuota, assertScopeQuota, assertStudentQuota } from "../lib/quota";
import {
  MAX_FILE_BYTES,
  MAX_LOG_FILES,
  MAX_PROGRESS_FILES,
  MAX_REPLY_FILES,
  MAX_REVIEW_FILES,
  MAX_SHARE_FILES,
  MAX_TASK_FILES,
  decryptFile,
  deleteStoredObjects,
  encryptFile,
  fileMeta,
  getStoredObject,
  putStoredObject,
  type FileRow,
} from "../lib/storage";
import { assertShareVisible } from "../lib/share-audience";

export const fileRoutes = new Hono<AppEnv>();
fileRoutes.use("*", requireAuth);

const SAFE_INLINE_IMAGE = /^image\/(jpeg|png|gif|webp|bmp|avif)$/i;
/** 附件支持 7z / tar 压缩包（含分卷，如 .7z.001、.tar.001）与常见图片 */
const ARCHIVE_EXT = /\.(7z|tar)(\.\d{3})?$/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|avif)$/i;
const IMAGE_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
};

function isFile(value: unknown): value is File {
  return !!value && typeof value === "object" && typeof (value as File).arrayBuffer === "function" && typeof (value as File).name === "string";
}

function mimeFromName(name: string): string | null {
  const lower = name.toLowerCase();
  if (/\.7z(?:\.\d{3})?$/.test(lower)) return "application/x-7z-compressed";
  if (/\.tar(?:\.\d{3})?$/.test(lower)) return "application/x-tar";
  const ext = lower.match(/\.([a-z0-9]+)$/)?.[1];
  return ext ? (IMAGE_MIME[ext] ?? null) : null;
}

/** 只允许上传图片或 7z / tar 压缩包；Office、脚本、Markdown、音视频等一律拒绝 */
function assertAttachmentFile(name: string) {
  if (!ARCHIVE_EXT.test(name) && !IMAGE_EXT.test(name)) {
    throw new HttpError(400, "仅支持上传 JPG、PNG、GIF、WebP、BMP、AVIF 图片或 7z / tar 压缩包（可上传分卷，如 .7z.001、.tar.001）");
  }
}

function cleanName(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? "附件";
  return (
    base
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 180) || "附件"
  );
}

function displayName(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_").slice(0, 120) || "file";
  return `filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** 任务说明 / 资料分享附件对所有有权限的已登录成员可见；其它附件仅管理员、上传者或所属学员可访问 */
async function canReadFile(env: Env, user: SessionUser, file: FileRow): Promise<boolean> {
  if (user.role === "admin" || file.owner_user_id === user.id || file.uploader_id === user.id || file.scope === "task") return true;
  if (file.scope === "share" && file.share_id) {
    try {
      await assertShareVisible(env, file.share_id, user);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * 图片编辑权限：管理员（辅导员 / 超管）可编辑所有图片；
 * 学员只能编辑自己上传的日志 / 作品 / 留言图片，且已提交或已通过审核的作品不可编辑。
 */
async function assertCanEditImage(env: Env, user: SessionUser, file: FileRow): Promise<void> {
  if (user.role === "admin") return;
  if (file.uploader_id !== user.id) throw new HttpError(403, "只能编辑自己上传的图片");
  if (file.scope !== "log" && file.scope !== "progress" && file.scope !== "reply") {
    throw new HttpError(403, "无权编辑该图片");
  }
  if (file.scope === "progress" && file.task_id) {
    const progress = await env.DB.prepare("SELECT status FROM progress WHERE task_id = ? AND user_id = ?")
      .bind(file.task_id, file.owner_user_id)
      .first<{ status: string }>();
    if (progress?.status === "submitted" || progress?.status === "approved") {
      throw new HttpError(409, "已提交审核，如需修改请先撤回");
    }
  }
}

/** 编辑后替换内容时，按新的扩展名 / MIME 修正文件名 */
function editedImageName(candidate: string, mime: string, fallback: string): string {
  const cleaned = cleanName(candidate || fallback);
  if (IMAGE_EXT.test(cleaned)) return cleaned;
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : mime === "image/bmp" ? "bmp" : mime === "image/avif" ? "avif" : "jpg";
  const base = cleaned.replace(/\.[^./\\]*$/, "") || "image";
  return `${base}.${ext}`;
}

/** 上传附件：学员上传日志 / 作品附件；管理员上传任务说明、审核批注、日志批注附件 */
fileRoutes.post("/", async (c) => {
  const user = c.get("user");

  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    throw new HttpError(400, "上传数据格式不正确");
  }

  const file = form.get("file");
  if (!isFile(file)) throw new HttpError(400, "请选择要上传的文件");
  if (!file.size) throw new HttpError(400, "不能上传空文件");
  if (file.size > MAX_FILE_BYTES) throw new HttpError(400, `单个文件不能超过 ${MAX_FILE_BYTES / 1024 / 1024} MB`);

  const rawScope = String(form.get("scope") ?? "");
  const allowedScopes = ["log", "progress", "task", "review", "reply", "share"] as const;
  type Scope = (typeof allowedScopes)[number];
  const scope: Scope = allowedScopes.includes(rawScope as Scope) ? (rawScope as Scope) : "log";
  let taskId: number | null = null;
  let shareId: number | null = null;
  let logId: number | null = null;
  let ownerUserId = user.id;

  if (user.role === "admin") {
    if (scope === "progress") throw new HttpError(403, "管理员不能上传学员作品附件");
    if (scope === "log") {
      logId = int(form.get("log_id"), "日志ID")!;
      const log = await c.env.DB.prepare("SELECT id, user_id FROM study_logs WHERE id = ?").bind(logId).first<{ id: number; user_id: number }>();
      if (!log) throw new HttpError(404, "日志不存在");
      ownerUserId = log.user_id;
      const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM files WHERE scope = 'log' AND log_id = ? AND uploader_id = ?")
        .bind(logId, user.id)
        .first<{ n: number }>();
      if ((count?.n ?? 0) >= MAX_LOG_FILES) throw new HttpError(400, `每条日志最多添加 ${MAX_LOG_FILES} 个辅导员批注附件`);
    } else if (scope === "reply") {
      // 辅导员给学员日志留言时上传的图片 / 文件，提交留言后再绑定 reply_id
      logId = int(form.get("log_id"), "日志ID")!;
      const log = await c.env.DB.prepare("SELECT id, user_id FROM study_logs WHERE id = ?").bind(logId).first<{ id: number; user_id: number }>();
      if (!log) throw new HttpError(404, "日志不存在");
      ownerUserId = log.user_id;
      const count = await c.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM files WHERE scope = 'reply' AND log_id = ? AND uploader_id = ? AND reply_id IS NULL",
      )
        .bind(logId, user.id)
        .first<{ n: number }>();
      if ((count?.n ?? 0) >= MAX_REPLY_FILES) throw new HttpError(400, `每条留言最多添加 ${MAX_REPLY_FILES} 个附件`);
    } else if (scope === "review") {
      taskId = int(form.get("task_id"), "任务ID")!;
      ownerUserId = int(form.get("owner_user_id"), "学员ID")!;
      const [task, target] = await c.env.DB.batch([
        c.env.DB.prepare("SELECT id FROM tasks WHERE id = ?").bind(taskId),
        c.env.DB.prepare("SELECT id FROM users WHERE id = ? AND role = 'student'").bind(ownerUserId),
      ]);
      if (!task.results[0]) throw new HttpError(404, "任务不存在");
      if (!target.results[0]) throw new HttpError(404, "学员不存在");
      const count = await c.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM files WHERE scope = 'review' AND task_id = ? AND owner_user_id = ? AND review_event_id IS NULL",
      )
        .bind(taskId, ownerUserId)
        .first<{ n: number }>();
      if ((count?.n ?? 0) >= MAX_REVIEW_FILES) throw new HttpError(400, `每次审核最多添加 ${MAX_REVIEW_FILES} 个批注附件`);
    } else if (scope === "share") {
      // share：资料附件；新建资料时可先上传，保存资料后再绑定 share_id
      const rawShareId = int(form.get("share_id"), "资料ID", { optional: true });
      if (rawShareId) {
        const share = await c.env.DB.prepare("SELECT id FROM shares WHERE id = ?").bind(rawShareId).first();
        if (!share) throw new HttpError(404, "资料不存在");
        shareId = rawShareId;
      }
      const count = await c.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM files WHERE scope = 'share' AND uploader_id = ? AND (share_id IS NULL OR share_id = ?)`,
      )
        .bind(user.id, shareId ?? -1)
        .first<{ n: number }>();
      if ((count?.n ?? 0) >= MAX_SHARE_FILES) throw new HttpError(400, `每篇资料最多 ${MAX_SHARE_FILES} 个附件`);
    } else {
      // task：任务说明附件；新建任务时可先上传，保存任务后再绑定
      const rawTaskId = int(form.get("task_id"), "任务ID", { optional: true });
      if (rawTaskId) {
        const task = await c.env.DB.prepare("SELECT id FROM tasks WHERE id = ?").bind(rawTaskId).first();
        if (!task) throw new HttpError(404, "任务不存在");
        taskId = rawTaskId;
      }
      const count = await c.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM files WHERE scope = 'task' AND uploader_id = ? AND (task_id IS NULL OR task_id = ?)`,
      )
        .bind(user.id, taskId ?? -1)
        .first<{ n: number }>();
      if ((count?.n ?? 0) >= MAX_TASK_FILES) throw new HttpError(400, `每个任务最多 ${MAX_TASK_FILES} 个说明附件`);
    }
  } else {
    if (scope !== "log" && scope !== "progress" && scope !== "reply") throw new HttpError(403, "无权上传该类型的附件");
    if (scope === "reply") {
      // 学员回复辅导员留言时上传的图片 / 文件
      logId = int(form.get("log_id"), "日志ID")!;
      const log = await c.env.DB.prepare("SELECT id FROM study_logs WHERE id = ? AND user_id = ?")
        .bind(logId, user.id)
        .first<{ id: number }>();
      if (!log) throw new HttpError(404, "日志不存在");
      const count = await c.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM files WHERE scope = 'reply' AND log_id = ? AND uploader_id = ? AND reply_id IS NULL",
      )
        .bind(logId, user.id)
        .first<{ n: number }>();
      if ((count?.n ?? 0) >= MAX_REPLY_FILES) throw new HttpError(400, `每条留言最多添加 ${MAX_REPLY_FILES} 个附件`);
    }
    if (scope === "progress") {
      taskId = int(form.get("task_id"), "任务ID")!;
      const task = await c.env.DB.prepare(
        `SELECT t.id, p.status
           FROM tasks t
           LEFT JOIN progress p ON p.task_id = t.id AND p.user_id = ?1
          WHERE t.id = ?2 AND t.status = 'published'
            AND (
              NOT EXISTS (SELECT 1 FROM task_classes tc WHERE tc.task_id = t.id)
              OR EXISTS (SELECT 1 FROM task_classes tc WHERE tc.task_id = t.id AND tc.class_id = ?3)
            )
            AND NOT EXISTS (SELECT 1 FROM task_exclusions te WHERE te.task_id = t.id AND te.user_id = ?1)`,
      )
        .bind(user.id, taskId, user.class_id)
        .first<{ id: number; status: string | null }>();
      if (!task) throw new HttpError(404, "任务不存在或未发布");
      if (task.status === "submitted" || task.status === "approved") {
        throw new HttpError(409, "已提交审核，如需修改请先撤回");
      }
      const count = await c.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM files WHERE scope = 'progress' AND task_id = ? AND owner_user_id = ?",
      )
        .bind(taskId, user.id)
        .first<{ n: number }>();
      if ((count?.n ?? 0) >= MAX_PROGRESS_FILES) {
        throw new HttpError(400, `每个任务最多上传 ${MAX_PROGRESS_FILES} 个作品附件`);
      }
    }
  }

  // 学员总配额只约束学员本人上传；辅导员批注不计入学员配额，避免学员满额后无法批注
  if (user.role === "student") {
    await assertStudentQuota(c.env, user.id, file.size);
  }

  // 单条日志 / 任务 / 留言 / 审核的附件总量；未绑定日志 / 任务的草稿在绑定时再检查
  if (scope === "log" && logId !== null) {
    await assertScopeQuota(c.env, { scope: "log", logId }, file.size);
  } else if (scope === "task" && taskId !== null) {
    await assertScopeQuota(c.env, { scope: "task", taskId }, file.size);
  } else if (scope === "share" && shareId !== null) {
    await assertScopeQuota(c.env, { scope: "share", shareId }, file.size);
  } else if (scope === "progress" && taskId !== null) {
    await assertScopeQuota(c.env, { scope: "progress", taskId, ownerUserId: user.id }, file.size);
  } else if (scope === "review") {
    await assertScopeQuota(c.env, { scope: "review", taskId: taskId!, ownerUserId }, file.size);
  } else if (scope === "reply" && logId !== null) {
    await assertScopeQuota(c.env, { scope: "reply", logId, uploaderId: user.id }, file.size);
  } else if (scope === "log") {
    await assertPendingScopeQuota(c.env, "log", user.id, file.size);
  } else if (scope === "task") {
    await assertPendingScopeQuota(c.env, "task", user.id, file.size);
  } else if (scope === "share") {
    await assertPendingScopeQuota(c.env, "share", user.id, file.size);
  }

  const id = crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
  const r2Key = `files/${id}`;
  const name = cleanName(file.name);
  assertAttachmentFile(name);
  const suppliedMime = file.type || "";
  const fromName = mimeFromName(name);
  const mime = (fromName ?? (SAFE_INLINE_IMAGE.test(suppliedMime) ? suppliedMime : "application/octet-stream")).slice(0, 120);
  const { iv, data } = await encryptFile(c.env, id, await file.arrayBuffer());

  await putStoredObject(c.env, r2Key, data);

  let row: FileRow;
  try {
    row = (await c.env.DB.prepare(
      `INSERT INTO files (id, uploader_id, owner_user_id, scope, log_id, task_id, share_id, name, mime, size, iv, r2_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
      .bind(id, user.id, ownerUserId, scope, logId, taskId, shareId, name, mime, file.size, iv, r2Key)
      .first()) as FileRow;
  } catch (err) {
    await deleteStoredObjects(c.env, [r2Key]);
    throw err;
  }

  return c.json({ file: fileMeta(row) });
});

/** 查询附件元数据与当前用户的编辑权限：预览页据此决定是否显示编辑按钮 */
fileRoutes.get("/:id/meta", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (!/^[a-f0-9]{32}$/.test(id)) throw new HttpError(404, "文件不存在");

  const file = await c.env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(id).first<FileRow>();
  if (!file) throw new HttpError(404, "文件不存在");
  if (!(await canReadFile(c.env, user, file))) throw new HttpError(403, "无权访问该文件");

  let canEdit = false;
  let reason: string | null = null;
  try {
    await assertCanEditImage(c.env, user, file);
    canEdit = SAFE_INLINE_IMAGE.test(file.mime) && IMAGE_EXT.test(file.name);
    if (!canEdit) reason = "该文件不是可编辑的图片";
  } catch (err) {
    reason = err instanceof HttpError ? err.message : "无权编辑该图片";
  }

  return c.json({
    file: fileMeta(file),
    permission: { can_read: true, can_edit: canEdit, reason },
  });
});

/** 下载 / 预览附件：管理员或附件所属学员可访问，读取时解密 */
fileRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (!/^[a-f0-9]{32}$/.test(id)) throw new HttpError(404, "文件不存在");

  const file = await c.env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(id).first<FileRow>();
  if (!file) throw new HttpError(404, "文件不存在");
  if (!(await canReadFile(c.env, user, file))) throw new HttpError(403, "无权访问该文件");

  const object = await getStoredObject(c.env, file.r2_key);
  if (!object) throw new HttpError(404, "文件内容不存在，可能已被清理");

  let data: ArrayBuffer;
  try {
    data = await decryptFile(c.env, file, object);
  } catch (err) {
    console.error("decrypt file failed", file.id, err);
    throw new HttpError(500, "文件解密失败，可能是加密密钥已变更");
  }

  const inline = SAFE_INLINE_IMAGE.test(file.mime);
  return c.body(data, 200, {
    "Content-Type": file.mime,
    "Content-Length": String(data.byteLength),
    "Content-Disposition": `${inline ? "inline" : "attachment"}; ${displayName(file.name)}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox",
  });
});

/**
 * 替换图片内容：图片编辑器保存 / 压缩后覆盖原文件。
 * 学员只能替换自己上传的图片，辅导员 / 管理员可替换所有图片。
 */
fileRoutes.put("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (!/^[a-f0-9]{32}$/.test(id)) throw new HttpError(404, "文件不存在");

  const file = await c.env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(id).first<FileRow>();
  if (!file) throw new HttpError(404, "文件不存在");
  if (!SAFE_INLINE_IMAGE.test(file.mime) || !IMAGE_EXT.test(file.name)) {
    throw new HttpError(400, "仅支持替换图片文件");
  }
  await assertCanEditImage(c.env, user, file);

  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    throw new HttpError(400, "上传数据格式不正确");
  }

  const upload = form.get("file");
  if (!isFile(upload)) throw new HttpError(400, "请选择要保存的图片");
  if (!upload.size) throw new HttpError(400, "不能保存空图片");
  if (upload.size > MAX_FILE_BYTES) throw new HttpError(400, `单个文件不能超过 ${MAX_FILE_BYTES / 1024 / 1024} MB`);

  const requestedName = cleanName(String(form.get("name") ?? "") || upload.name);
  const suppliedMime = upload.type || "";
  const fromName = mimeFromName(requestedName);
  const mime = (fromName ?? (SAFE_INLINE_IMAGE.test(suppliedMime) ? suppliedMime : "image/jpeg")).slice(0, 120);
  if (!SAFE_INLINE_IMAGE.test(mime)) throw new HttpError(400, "仅支持保存为 JPG、PNG、GIF、WebP、BMP、AVIF 图片");
  const name = editedImageName(requestedName, mime, file.name);

  // 只对体积增量检查配额，压缩变小不占用额外空间
  const delta = Math.max(0, upload.size - file.size);
  if (delta > 0) {
    if (user.role === "student") await assertStudentQuota(c.env, user.id, delta);

    if (file.scope === "log") {
      if (file.log_id) await assertScopeQuota(c.env, { scope: "log", logId: file.log_id }, delta);
      else await assertPendingScopeQuota(c.env, "log", file.uploader_id, delta);
    } else if (file.scope === "progress" && file.task_id) {
      await assertScopeQuota(c.env, { scope: "progress", taskId: file.task_id, ownerUserId: file.owner_user_id }, delta);
    } else if (file.scope === "task") {
      if (file.task_id) await assertScopeQuota(c.env, { scope: "task", taskId: file.task_id }, delta);
      else await assertPendingScopeQuota(c.env, "task", file.uploader_id, delta);
    } else if (file.scope === "review" && file.task_id) {
      await assertScopeQuota(
        c.env,
        { scope: "review", taskId: file.task_id, ownerUserId: file.owner_user_id, reviewEventId: file.review_event_id },
        delta,
      );
    } else if (file.scope === "reply" && file.log_id) {
      await assertScopeQuota(
        c.env,
        { scope: "reply", logId: file.log_id, uploaderId: file.uploader_id, replyId: file.reply_id },
        delta,
      );
    }
  }

  const previous = await getStoredObject(c.env, file.r2_key);
  const { iv, data } = await encryptFile(c.env, file.id, await upload.arrayBuffer());
  await putStoredObject(c.env, file.r2_key, data);

  let row: FileRow;
  try {
    row = (await c.env.DB.prepare(
      `UPDATE files SET name = ?, mime = ?, size = ?, iv = ? WHERE id = ? RETURNING *`,
    )
      .bind(name, mime, upload.size, iv, id)
      .first()) as FileRow;
  } catch (err) {
    // 数据库更新失败时恢复旧内容，避免密文与 iv 不匹配导致无法读取
    if (previous) {
      await putStoredObject(c.env, file.r2_key, previous).catch((restoreErr) => {
        console.error("restore file object failed", file.id, restoreErr);
      });
    }
    throw err;
  }

  return c.json({ file: fileMeta(row) });
});

/** 删除附件（学员删除自己的，管理员可删除任意） */
fileRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (!/^[a-f0-9]{32}$/.test(id)) throw new HttpError(404, "文件不存在");

  const file = await c.env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(id).first<FileRow>();
  if (!file) throw new HttpError(404, "文件不存在");
  if (user.role !== "admin") {
    // 学员只能删除自己上传的学习日志 / 作品附件，不能删除辅导员批注附件
    if (file.uploader_id !== user.id) throw new HttpError(403, "无权删除该文件");
    if (file.scope !== "log" && file.scope !== "progress" && file.scope !== "reply") throw new HttpError(403, "无权删除该文件");
    if (file.scope === "progress" && file.task_id) {
      const progress = await c.env.DB.prepare("SELECT status FROM progress WHERE task_id = ? AND user_id = ?")
        .bind(file.task_id, file.owner_user_id)
        .first<{ status: string }>();
      if (progress?.status === "submitted" || progress?.status === "approved") {
        throw new HttpError(409, "已提交审核，如需修改请先撤回");
      }
    }
  }

  await c.env.DB.prepare("DELETE FROM files WHERE id = ?").bind(id).run();
  await deleteStoredObjects(c.env, [file.r2_key]);
  return c.json({ ok: true });
});
