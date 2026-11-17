export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** R2 存储桶（wrangler.jsonc 中默认自动创建），保存加密后的附件与头像 */
  FILES?: R2Bucket;
  /** 可选：使用 KV 保存加密后的文件内容；与 R2 二选一，系统自动使用实际绑定的存储 */
  FILE_KV?: KVNamespace;
  /** 可选：强制指定存储后端（r2 / kv），覆盖自动识别结果 */
  FILE_STORAGE?: string;
  /** 可选：32 字节统一加密密钥（Base64 / 64 位十六进制 / 32 字符）。未配置时自动生成并保存到 D1。 */
  FILE_ENCRYPTION_KEY?: string;
  /** 可选：存储容量展示上限（MB）。未配置时按 R2 10 GB / KV 1 GB 的免费额度显示。 */
  STORAGE_TOTAL_MB?: string;
  /** 可选：单条日志 / 任务 / 留言 / 审核的附件总量上限（MB），默认 100。 */
  STORAGE_SCOPE_MB?: string;
  /** 可选：每个学员的附件总量上限（MB），默认 512。 */
  STORAGE_STUDENT_MB?: string;
}

export interface SessionUser {
  id: number;
  username: string;
  name: string;
  role: "admin" | "student";
  /** 管理员（可管理团队、数据备份与学员账号）；辅导员为 0 */
  is_super_admin: number;
  class_id: number | null;
  class_name: string | null;
  avatar_id: string | null;
  must_change_password: number;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { user: SessionUser; sessionId: string };
};
