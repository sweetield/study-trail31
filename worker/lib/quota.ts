import type { Env } from "../types";
import { HttpError } from "./validate";

const MB = 1024 * 1024;

/** 单条日志 / 任务 / 留言 / 审核的附件总量上限（默认 100 MB，可用 STORAGE_SCOPE_MB 覆盖） */
export const DEFAULT_SCOPE_QUOTA_MB = 100;
/** 每个学员的附件总量上限（默认 512 MB，可用 STORAGE_STUDENT_MB 覆盖） */
export const DEFAULT_STUDENT_QUOTA_MB = 512;
/** 容量展示口径：R2 免费额度 10 GB，KV 免费额度 1 GB；可用 STORAGE_TOTAL_MB 覆盖 */
export const DEFAULT_TOTAL_MB = { r2: 10 * 1024, kv: 1 * 1024 } as const;

export function formatStorageBytes(size: number): string {
  if (size >= 1024 * MB) return `${(size / 1024 / MB).toFixed(2)} GB`;
  if (size >= MB) return `${(size / MB).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${Math.max(0, Math.round(size))} B`;
}

function readMb(value: string | undefined, fallback: number): number {
  if (value === undefined || value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function scopeQuotaBytes(env: Env): number {
  return readMb(env.STORAGE_SCOPE_MB, DEFAULT_SCOPE_QUOTA_MB) * MB;
}

export function studentQuotaBytes(env: Env): number {
  return readMb(env.STORAGE_STUDENT_MB, DEFAULT_STUDENT_QUOTA_MB) * MB;
}

export function storageCapacity(env: Env, backend: "r2" | "kv" | null): { bytes: number; mb: number; source: "env" | "default" } {
  const fallback = backend === "kv" ? DEFAULT_TOTAL_MB.kv : DEFAULT_TOTAL_MB.r2;
  const configured = env.STORAGE_TOTAL_MB?.trim();
  const valid = !!configured && Number.isFinite(Number(configured)) && Number(configured) > 0;
  const mb = valid ? Math.floor(Number(configured)) : fallback;
  return { bytes: mb * MB, mb, source: valid ? "env" : "default" };
}

/** 学员名下的附件（含辅导员在该学员日志 / 审核里添加的附件）与头像总量 */
export async function studentUsageBytes(env: Env, userId: number): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE((SELECT SUM(size) FROM files WHERE owner_user_id = ?1), 0)
          + COALESCE((SELECT size FROM avatars WHERE user_id = ?1), 0) AS bytes`,
  )
    .bind(userId)
    .first<{ bytes: number }>();
  return Number(row?.bytes ?? 0);
}

export async function assertStudentQuota(env: Env, userId: number, incomingBytes: number): Promise<void> {
  const limit = studentQuotaBytes(env);
  const used = await studentUsageBytes(env, userId);
  if (used + incomingBytes > limit) {
    throw new HttpError(
      400,
      `存储空间不足：已用 ${formatStorageBytes(used)}，本次上传 ${formatStorageBytes(incomingBytes)}，单个学员上限 ${formatStorageBytes(limit)}`,
    );
  }
}

export type ScopeTarget =
  | { scope: "log"; logId: number }
  | { scope: "task"; taskId: number }
  | { scope: "progress"; taskId: number; ownerUserId: number }
  | { scope: "review"; taskId: number; ownerUserId: number; reviewEventId?: number | null }
  | { scope: "reply"; logId: number; uploaderId: number; replyId?: number | null }
  | { scope: "share"; shareId: number };

const SCOPE_LABELS: Record<ScopeTarget["scope"], string> = {
  log: "本条日志",
  task: "该任务",
  progress: "该任务作品",
  review: "本次审核",
  reply: "本条留言",
  share: "本篇资料",
};

async function scopeUsageBytes(env: Env, target: ScopeTarget): Promise<number> {
  let where: string;
  let params: number[];
  switch (target.scope) {
    case "log":
      where = "scope = 'log' AND log_id = ?";
      params = [target.logId];
      break;
    case "task":
      where = "scope = 'task' AND task_id = ?";
      params = [target.taskId];
      break;
    case "progress":
      where = "scope = 'progress' AND task_id = ? AND owner_user_id = ?";
      params = [target.taskId, target.ownerUserId];
      break;
    case "review":
      if (target.reviewEventId) {
        where = "scope = 'review' AND review_event_id = ?";
        params = [target.reviewEventId];
      } else {
        where = "scope = 'review' AND task_id = ? AND owner_user_id = ? AND review_event_id IS NULL";
        params = [target.taskId, target.ownerUserId];
      }
      break;
    case "reply":
      if (target.replyId) {
        where = "scope = 'reply' AND reply_id = ?";
        params = [target.replyId];
      } else {
        where = "scope = 'reply' AND log_id = ? AND uploader_id = ? AND reply_id IS NULL";
        params = [target.logId, target.uploaderId];
      }
      break;
    case "share":
      where = "scope = 'share' AND share_id = ?";
      params = [target.shareId];
      break;
  }
  const row = await env.DB.prepare(`SELECT COALESCE(SUM(size), 0) AS bytes FROM files WHERE ${where}`)
    .bind(...params)
    .first<{ bytes: number }>();
  return Number(row?.bytes ?? 0);
}

/**
 * 尚未绑定日志 / 任务的草稿附件同样计入单作用域总量，
 * 避免先上传大量文件、保存时才发现超限。
 */
export async function assertPendingScopeQuota(
  env: Env,
  scope: "log" | "task" | "share",
  uploaderId: number,
  incomingBytes: number,
): Promise<void> {
  const limit = scopeQuotaBytes(env);
  const column = scope === "log" ? "log_id" : scope === "task" ? "task_id" : "share_id";
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(size), 0) AS bytes FROM files WHERE scope = ? AND uploader_id = ? AND ${column} IS NULL`,
  )
    .bind(scope, uploaderId)
    .first<{ bytes: number }>();
  const used = Number(row?.bytes ?? 0);
  if (used + incomingBytes > limit) {
    throw new HttpError(
      400,
      `${SCOPE_LABELS[scope]}附件总量不能超过 ${formatStorageBytes(limit)}（已用 ${formatStorageBytes(used)}，本次 ${formatStorageBytes(incomingBytes)}）`,
    );
  }
}

/** 绑定或上传前检查单条日志 / 任务 / 留言 / 审核的附件总量 */
export async function assertScopeQuota(env: Env, target: ScopeTarget, incomingBytes: number): Promise<void> {
  const limit = scopeQuotaBytes(env);
  const used = await scopeUsageBytes(env, target);
  if (used + incomingBytes > limit) {
    throw new HttpError(
      400,
      `${SCOPE_LABELS[target.scope]}附件总量不能超过 ${formatStorageBytes(limit)}（已用 ${formatStorageBytes(used)}，本次 ${formatStorageBytes(incomingBytes)}）`,
    );
  }
}
