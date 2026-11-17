import type { Env } from "../types";
import { HttpError } from "./validate";
import { assertScopeQuota } from "./quota";

const encoder = new TextEncoder();

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
export const MAX_LOG_FILES = 20;
export const MAX_PROGRESS_FILES = 20;
export const MAX_TASK_FILES = 20;
export const MAX_REVIEW_FILES = 20;
export const MAX_REPLY_FILES = 20;
export const MAX_SHARE_FILES = 20;

/** Cloudflare KV 单个 value 上限为 25 MiB，加密后仍需留出少量空间 */
const MAX_KV_BYTES = 25 * 1024 * 1024;

export interface FileRow {
  id: string;
  uploader_id: number;
  owner_user_id: number;
  scope: "log" | "progress" | "task" | "review" | "reply" | "share";
  log_id: number | null;
  task_id: number | null;
  share_id: number | null;
  reply_id: number | null;
  review_event_id: number | null;
  name: string;
  mime: string;
  size: number;
  iv: string;
  r2_key: string;
  created_at: number;
}

export interface FileMeta {
  id: string;
  uploader_id: number;
  name: string;
  mime: string;
  size: number;
  created_at: number;
}

export interface AvatarRow {
  user_id: number;
  id: string;
  name: string;
  mime: string;
  size: number;
  iv: string;
  storage_key: string;
  created_at: number;
}

export function fileMeta(row: Pick<FileRow, "id" | "uploader_id" | "name" | "mime" | "size" | "created_at">): FileMeta {
  return {
    id: row.id,
    uploader_id: row.uploader_id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    created_at: row.created_at,
  };
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** 接受 Base64、64 位十六进制或 32 字符原始密钥，统一转成 32 字节 */
function parseSecret(value: string): Uint8Array<ArrayBuffer> {
  const text = value.trim();
  if (/^[a-f0-9]{64}$/i.test(text)) return fromHex(text);
  try {
    const decoded = fromBase64(text);
    if (decoded.length === 32) return decoded;
  } catch {
    // 不是 Base64，继续尝试原始字符串
  }
  const raw = encoder.encode(text);
  if (raw.length === 32) return raw;
  throw new Error("FILE_ENCRYPTION_KEY 必须是 32 字节（Base64、64 位十六进制或 32 字符）");
}

async function importKey(bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

let keyPromise: Promise<CryptoKey> | null = null;

async function loadKey(env: Env): Promise<CryptoKey> {
  const configured = env.FILE_ENCRYPTION_KEY?.trim();
  if (configured) return importKey(parseSecret(configured));

  const select = env.DB.prepare("SELECT value FROM app_settings WHERE key = 'file_encryption_key'");
  let row = await select.first<{ value: string }>();
  if (!row) {
    // 一键部署时无需手动配置：首次使用自动生成统一密钥并保存在 D1。
    // 多个实例同时冷启动时使用 INSERT OR IGNORE，再读取实际写入的值。
    const generated = toBase64(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('file_encryption_key', ?)")
      .bind(generated)
      .run();
    row = await select.first<{ value: string }>();
  }
  if (!row) throw new Error("无法初始化文件加密密钥");
  return importKey(parseSecret(row.value));
}

export function getEncryptionKey(env: Env): Promise<CryptoKey> {
  keyPromise ??= loadKey(env).catch((err) => {
    keyPromise = null;
    throw err;
  });
  return keyPromise;
}

/** 从备份恢复 app_settings 后清除缓存，确保使用恢复后的密钥 */
export function resetEncryptionKeyCache(): void {
  keyPromise = null;
}

export async function encryptFile(
  env: Env,
  fileId: string,
  data: ArrayBuffer,
): Promise<{ iv: string; data: ArrayBuffer }> {
  const key = await getEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  // 用文件 ID 作为附加认证数据，避免密文被调换到其他文件记录上
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(fileId) },
    key,
    data,
  );
  return { iv: toHex(iv), data: encrypted };
}

export async function decryptFile(env: Env, file: Pick<FileRow, "id" | "iv"> | Pick<AvatarRow, "id" | "iv">, data: ArrayBuffer): Promise<ArrayBuffer> {
  const key = await getEncryptionKey(env);
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromHex(file.iv), additionalData: encoder.encode(file.id) },
    key,
    data,
  );
}

export type StorageBackend = "r2" | "kv";

export const STORAGE_LABELS: Record<StorageBackend, string> = {
  r2: "R2 对象存储",
  kv: "KV 键值存储",
};

/** 当前部署实际绑定的存储后端；正常部署只需其中一种，同时存在时由 storageBackend 选择 */
export function availableStorageBackends(env: Env): StorageBackend[] {
  const backends: StorageBackend[] = [];
  if (env.FILES) backends.push("r2");
  if (env.FILE_KV) backends.push("kv");
  return backends;
}

/**
 * 文件内容存储后端。部署时绑定哪一种就使用哪一种，不在系统内切换。优先级：
 * 1. 环境变量 FILE_STORAGE（r2 / kv）指定（对应绑定不存在时自动回退）；
 * 2. 旧版本保存在 app_settings.file_storage 中的选择（兼容升级前的部署）；
 * 3. 实际绑定的存储；同时绑定时默认 R2。
 */
export async function storageBackend(env: Env): Promise<StorageBackend> {
  const available = availableStorageBackends(env);
  if (!available.length) {
    throw new Error("未绑定文件存储：请在 wrangler.jsonc 中配置 R2（FILES）或 KV（FILE_KV）");
  }

  const forced = env.FILE_STORAGE?.trim().toLowerCase();
  if (forced === "r2" || forced === "kv") {
    if (available.includes(forced)) return forced;
    // 配置了已移除的绑定时不阻断整个系统，回退到实际可用的存储
    console.warn(`FILE_STORAGE=${forced}，但当前部署没有绑定${STORAGE_LABELS[forced]}，已回退到可用存储`);
  }

  const saved = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'file_storage'")
    .first<{ value: string }>()
    .catch(() => null);
  if (saved && available.includes(saved.value as StorageBackend)) {
    return saved.value as StorageBackend;
  }
  return available.includes("r2") ? "r2" : "kv";
}

export async function putStoredObject(env: Env, key: string, data: ArrayBuffer, backend?: StorageBackend): Promise<void> {
  const target = backend ?? (await storageBackend(env));
  if (target === "kv") {
    if (data.byteLength > MAX_KV_BYTES) throw new HttpError(400, "文件超过 KV 存储上限，请改用 R2 或上传更小的文件");
    await env.FILE_KV!.put(key, data);
    return;
  }
  await env.FILES!.put(key, data, {
    httpMetadata: { contentType: "application/octet-stream", cacheControl: "private, no-store" },
  });
}

export async function getStoredObject(env: Env, key: string): Promise<ArrayBuffer | null> {
  if ((await storageBackend(env)) === "kv") {
    return (await env.FILE_KV!.get(key, "arrayBuffer")) ?? null;
  }
  const object = await env.FILES!.get(key);
  return object ? object.arrayBuffer() : null;
}

/** backend 用于恢复备份时按“旧数据所在的存储”清理，避免 app_settings 被覆盖后删错位置 */
export async function deleteStoredObjects(env: Env, keys: string[], backend?: StorageBackend): Promise<void> {
  if (!keys.length) return;
  // 未绑定存储时没有对象可删；不要让元数据删除因为缺少绑定而报错
  const target = backend ?? (await storageBackend(env).catch(() => null));
  if (!target) {
    console.warn("未绑定文件存储，已跳过对象删除");
    return;
  }
  if (target === "kv") {
    await Promise.allSettled(keys.map((key) => env.FILE_KV!.delete(key)));
    return;
  }
  // R2 支持一次删除多个 key；按 1000 个分批，减少对象存储操作次数与请求数
  for (let i = 0; i < keys.length; i += 1000) {
    await env.FILES!.delete(keys.slice(i, i + 1000)).catch((err) => {
      console.error("delete stored objects failed", err);
    });
  }
}

/** 校验并去重客户端传来的文件 ID */
export function normalizeFileIds(value: unknown, max = MAX_LOG_FILES): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (!Array.isArray(value)) throw new HttpError(400, "附件格式不正确");
  const ids = [...new Set(value.map((id) => String(id)))];
  if (ids.length > max) throw new HttpError(400, `最多上传 ${max} 个附件`);
  if (ids.some((id) => !/^[a-f0-9]{32}$/.test(id))) throw new HttpError(400, "附件 ID 格式不正确");
  return ids;
}

/**
 * 将已上传但尚未绑定的日志附件绑定到日志。
 * userId 为日志所属学员；管理员代传附件时通过 uploaderId 指定实际上传者。
 */
export async function bindLogFiles(env: Env, userId: number, logId: number, value: unknown, uploaderId = userId) {
  const ids = normalizeFileIds(value);
  if (!ids.length) return;
  const { results } = await env.DB.prepare(
    `SELECT id, uploader_id, owner_user_id, scope, log_id, size FROM files WHERE id IN (${ids.map(() => "?").join(", ")})`,
  )
    .bind(...ids)
    .all<Pick<FileRow, "id" | "uploader_id" | "owner_user_id" | "scope" | "log_id" | "size">>();

  const byId = new Map(results.map((row) => [row.id, row]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row || row.scope !== "log" || row.owner_user_id !== userId) {
      throw new HttpError(400, "附件不存在或无权使用");
    }
    if (row.log_id === logId) continue;
    if (row.uploader_id !== uploaderId) throw new HttpError(400, "附件不存在或无权使用");
    if (row.log_id !== null) throw new HttpError(409, "附件已被其他日志使用");
  }

  const pending = results.filter((row) => row.log_id === null);
  if (pending.length) {
    const existing = await env.DB.prepare("SELECT COUNT(*) AS n FROM files WHERE scope = 'log' AND log_id = ? AND reply_id IS NULL").bind(logId).first<{ n: number }>();
    if ((existing?.n ?? 0) + pending.length > MAX_LOG_FILES) {
      throw new HttpError(400, `每条日志最多 ${MAX_LOG_FILES} 个附件`);
    }
    await assertScopeQuota(env, { scope: "log", logId }, pending.reduce((sum, row) => sum + row.size, 0));
    await env.DB.batch(
      pending.map((row) =>
        env.DB.prepare("UPDATE files SET log_id = ? WHERE id = ? AND uploader_id = ? AND log_id IS NULL").bind(logId, row.id, uploaderId),
      ),
    );
  }
}

/** 移除并删除日志上的指定附件 */
export async function detachLogFiles(env: Env, userId: number, logId: number, value: unknown) {
  const ids = normalizeFileIds(value);
  if (!ids.length) return;
  const { results } = await env.DB.prepare(
    `SELECT id, r2_key FROM files
      WHERE scope = 'log' AND log_id = ? AND uploader_id = ? AND reply_id IS NULL AND id IN (${ids.map(() => "?").join(", ")})`,
  )
    .bind(logId, userId, ...ids)
    .all<{ id: string; r2_key: string }>();
  if (!results.length) return;
  await env.DB.prepare(`DELETE FROM files WHERE id IN (${results.map(() => "?").join(", ")})`)
    .bind(...results.map((row) => row.id))
    .run();
  await deleteStoredObjects(env, results.map((row) => row.r2_key));
}

export async function fileKeysForLog(env: Env, logId: number): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT r2_key FROM files WHERE log_id = ?").bind(logId).all<{ r2_key: string }>();
  return results.map((row) => row.r2_key);
}

/** 将管理员上传的任务说明附件绑定到任务 */
export async function bindTaskFiles(env: Env, adminId: number, taskId: number, value: unknown) {
  const ids = normalizeFileIds(value, MAX_TASK_FILES);
  if (!ids.length) return;
  const { results } = await env.DB.prepare(
    `SELECT id, uploader_id, scope, task_id, size FROM files WHERE id IN (${ids.map(() => "?").join(", ")})`,
  )
    .bind(...ids)
    .all<Pick<FileRow, "id" | "uploader_id" | "scope" | "task_id" | "size">>();

  const byId = new Map(results.map((row) => [row.id, row]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row || row.uploader_id !== adminId || row.scope !== "task") {
      throw new HttpError(400, "附件不存在或无权使用");
    }
    if (row.task_id !== null && row.task_id !== taskId) throw new HttpError(409, "附件已被其他任务使用");
  }

  const existing = await env.DB.prepare("SELECT COUNT(*) AS n FROM files WHERE scope = 'task' AND task_id = ?").bind(taskId).first<{ n: number }>();
  const pending = results.filter((row) => row.task_id === null);
  if ((existing?.n ?? 0) + pending.length > MAX_TASK_FILES) {
    throw new HttpError(400, `每个任务最多 ${MAX_TASK_FILES} 个说明附件`);
  }
  if (pending.length) {
    await assertScopeQuota(env, { scope: "task", taskId }, pending.reduce((sum, row) => sum + row.size, 0));
    await env.DB.batch(
      pending.map((row) =>
        env.DB.prepare("UPDATE files SET task_id = ? WHERE id = ? AND uploader_id = ? AND task_id IS NULL").bind(taskId, row.id, adminId),
      ),
    );
  }
}

/** 将学习日志留言附件绑定到具体留言 */
export async function bindReplyFiles(env: Env, logId: number, replyId: number, uploaderId: number, value: unknown) {
  const ids = normalizeFileIds(value, MAX_REPLY_FILES);
  if (!ids.length) return;
  const { results } = await env.DB.prepare(
    `SELECT id, uploader_id, scope, log_id, reply_id, size FROM files WHERE id IN (${ids.map(() => "?").join(", ")})`,
  )
    .bind(...ids)
    .all<Pick<FileRow, "id" | "uploader_id" | "scope" | "log_id" | "reply_id" | "size">>();

  const byId = new Map(results.map((row) => [row.id, row]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row || row.scope !== "reply" || row.log_id !== logId || row.uploader_id !== uploaderId) {
      throw new HttpError(400, "留言附件不存在或无权使用");
    }
    if (row.reply_id !== null && row.reply_id !== replyId) throw new HttpError(409, "留言附件已被其他留言使用");
  }

  const pending = results.filter((row) => row.reply_id === null);
  if (pending.length) {
    await assertScopeQuota(
      env,
      { scope: "reply", logId, uploaderId, replyId },
      pending.reduce((sum, row) => sum + row.size, 0),
    );
  }

  await env.DB.batch(
    ids.map((id) =>
      env.DB.prepare("UPDATE files SET reply_id = ? WHERE id = ? AND uploader_id = ? AND reply_id IS NULL").bind(replyId, id, uploaderId),
    ),
  );
}

/** 移除并删除任务说明上的指定附件 */
export async function detachTaskFiles(env: Env, adminId: number, taskId: number, value: unknown) {
  const ids = normalizeFileIds(value, MAX_TASK_FILES);
  if (!ids.length) return;
  const { results } = await env.DB.prepare(
    `SELECT id, r2_key FROM files
      WHERE scope = 'task' AND task_id = ? AND uploader_id = ? AND id IN (${ids.map(() => "?").join(", ")})`,
  )
    .bind(taskId, adminId, ...ids)
    .all<{ id: string; r2_key: string }>();
  if (!results.length) return;
  await env.DB.prepare(`DELETE FROM files WHERE id IN (${results.map(() => "?").join(", ")})`)
    .bind(...results.map((row) => row.id))
    .run();
  await deleteStoredObjects(env, results.map((row) => row.r2_key));
}

/** 审核完成后，把本轮上传的辅导员批注附件绑定到审核记录 */
export async function bindReviewFiles(env: Env, taskId: number, userId: number, eventId: number, value: unknown) {
  const ids = normalizeFileIds(value, MAX_REVIEW_FILES);
  if (!ids.length) return;
  const { results } = await env.DB.prepare(
    `SELECT id, scope, task_id, owner_user_id, review_event_id, size
       FROM files WHERE id IN (${ids.map(() => "?").join(", ")})`,
  )
    .bind(...ids)
    .all<Pick<FileRow, "id" | "scope" | "task_id" | "owner_user_id" | "review_event_id" | "size">>();

  const byId = new Map(results.map((row) => [row.id, row]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row || row.scope !== "review" || row.task_id !== taskId || row.owner_user_id !== userId) {
      throw new HttpError(400, "批注附件不存在或无权使用");
    }
    if (row.review_event_id !== null && row.review_event_id !== eventId) {
      throw new HttpError(409, "批注附件已被其他审核记录使用");
    }
  }

  const pending = results.filter((row) => row.review_event_id === null);
  if (pending.length) {
    await assertScopeQuota(
      env,
      { scope: "review", taskId, ownerUserId: userId, reviewEventId: eventId },
      pending.reduce((sum, row) => sum + row.size, 0),
    );
  }

  await env.DB.batch(
    ids.map((id) =>
      env.DB.prepare("UPDATE files SET review_event_id = ? WHERE id = ? AND scope = 'review' AND review_event_id IS NULL").bind(eventId, id),
    ),
  );
}


/** 将管理员上传的资料附件绑定到资料 */
export async function bindShareFiles(env: Env, adminId: number, shareId: number, value: unknown) {
  const ids = normalizeFileIds(value, MAX_SHARE_FILES);
  if (!ids.length) return;
  const { results } = await env.DB.prepare(
    `SELECT id, uploader_id, scope, share_id, size FROM files WHERE id IN (${ids.map(() => "?").join(", ")})`,
  )
    .bind(...ids)
    .all<Pick<FileRow, "id" | "uploader_id" | "scope" | "share_id" | "size">>();

  const byId = new Map(results.map((row) => [row.id, row]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row || row.uploader_id !== adminId || row.scope !== "share") {
      throw new HttpError(400, "附件不存在或无权使用");
    }
    if (row.share_id !== null && row.share_id !== shareId) throw new HttpError(409, "附件已被其他资料使用");
  }

  const existing = await env.DB.prepare("SELECT COUNT(*) AS n FROM files WHERE scope = 'share' AND share_id = ?")
    .bind(shareId)
    .first<{ n: number }>();
  const pending = results.filter((row) => row.share_id === null);
  if ((existing?.n ?? 0) + pending.length > MAX_SHARE_FILES) {
    throw new HttpError(400, `每篇资料最多 ${MAX_SHARE_FILES} 个附件`);
  }
  if (pending.length) {
    await assertScopeQuota(env, { scope: "share", shareId }, pending.reduce((sum, row) => sum + row.size, 0));
    await env.DB.batch(
      pending.map((row) =>
        env.DB.prepare("UPDATE files SET share_id = ? WHERE id = ? AND uploader_id = ? AND share_id IS NULL").bind(shareId, row.id, adminId),
      ),
    );
  }
}

/** 移除并删除资料上的指定附件 */
export async function detachShareFiles(env: Env, adminId: number, shareId: number, value: unknown) {
  const ids = normalizeFileIds(value, MAX_SHARE_FILES);
  if (!ids.length) return;
  const { results } = await env.DB.prepare(
    `SELECT id, r2_key FROM files
      WHERE scope = 'share' AND share_id = ? AND uploader_id = ? AND id IN (${ids.map(() => "?").join(", ")})`,
  )
    .bind(shareId, adminId, ...ids)
    .all<{ id: string; r2_key: string }>();
  if (!results.length) return;
  await env.DB.prepare(`DELETE FROM files WHERE id IN (${results.map(() => "?").join(", ")})`)
    .bind(...results.map((row) => row.id))
    .run();
  await deleteStoredObjects(env, results.map((row) => row.r2_key));
}

export async function fileKeysForShare(env: Env, shareId: number): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT r2_key FROM files WHERE share_id = ?").bind(shareId).all<{ r2_key: string }>();
  return results.map((row) => row.r2_key);
}

export async function fileKeysForTask(env: Env, taskId: number): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT r2_key FROM files WHERE task_id = ?").bind(taskId).all<{ r2_key: string }>();
  return results.map((row) => row.r2_key);
}

export async function fileKeysForUser(env: Env, userId: number): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT r2_key FROM files WHERE uploader_id = ? OR owner_user_id = ?")
    .bind(userId, userId)
    .all<{ r2_key: string }>();
  return results.map((row) => row.r2_key);
}

export async function avatarKeysForUser(env: Env, userId: number): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT storage_key FROM avatars WHERE user_id = ?").bind(userId).all<{ storage_key: string }>();
  return results.map((row) => row.storage_key);
}
