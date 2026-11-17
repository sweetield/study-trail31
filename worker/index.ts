import { Hono } from "hono";
import type { AppEnv, Env } from "./types";
import { HttpError } from "./lib/validate";
import { ensureSchema } from "./lib/migrate";
import { authRoutes } from "./routes/auth";
import { studentRoutes } from "./routes/student";
import { adminRoutes } from "./routes/admin";
import { dataRoutes } from "./routes/data";
import { teamRoutes } from "./routes/team";
import { notificationRoutes } from "./routes/notifications";
import { announcementRoutes } from "./routes/announcement";
import { fileRoutes } from "./routes/files";
import { avatarRoutes } from "./routes/avatars";
import { shareRoutes } from "./routes/shares";
import { deleteStoredObjects } from "./lib/storage";

const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_FULL_BACKUP_BYTES = 90 * 1024 * 1024;

const app = new Hono<AppEnv>().basePath("/api");

app.use("*", async (c, next) => {
  // CSRF 防护：跨站表单无法携带自定义请求头，且未开放 CORS
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    if (c.req.header("x-requested-with") !== "fetch") return c.json({ error: "非法请求" }, 403);
    // 完整备份按文件大小限制；multipart 还会带上密码等字段，额外留出 2 MB 余量
    const limit = new URL(c.req.url).pathname.endsWith("/admin/data/import-full")
      ? MAX_FULL_BACKUP_BYTES + 2 * 1024 * 1024
      : MAX_BODY_BYTES;
    if (Number(c.req.header("content-length") ?? 0) > limit) return c.json({ error: "请求数据过大" }, 413);
  }
  await ensureSchema(c.env.DB);
  await next();
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-Frame-Options", "DENY");
});

app.get("/health", async (c) => {
  await c.env.DB.prepare("SELECT 1").first();
  return c.json({ ok: true, time: new Date().toISOString() });
});

app.route("/auth", authRoutes);
app.route("/me", studentRoutes);
app.route("/notifications", notificationRoutes);
app.route("/announcement", announcementRoutes);
app.route("/files", fileRoutes);
app.route("/avatars", avatarRoutes);
app.route("/shares", shareRoutes);
app.route("/admin/data", dataRoutes);
app.route("/admin/team", teamRoutes);
app.route("/admin", adminRoutes);

app.notFound((c) => c.json({ error: "接口不存在" }, 404));

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  if (err instanceof SyntaxError) return c.json({ error: "请求数据格式错误" }, 400);
  console.error(err);
  return c.json({ error: "服务器错误，请稍后再试" }, 500);
});

async function cleanup(env: Env) {
  await ensureSchema(env.DB);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < ?").bind(now - 90 * 86400),
    // 未读通知只保留 30 天：即使学员从不点开，未读计数也不会无限增长
    env.DB.prepare("DELETE FROM notifications WHERE read_at IS NULL AND created_at < ?").bind(now - 30 * 86400),
    env.DB.prepare("DELETE FROM notifications WHERE created_at < ?").bind(now - 365 * 86400),
    env.DB.prepare("DELETE FROM task_urges WHERE due_at < ?").bind(now - 30 * 86400),
    env.DB.prepare("DELETE FROM audit_logs WHERE created_at < ?").bind(now - 2 * 365 * 86400),
  ]);

  // 清理上传后未完成绑定的草稿附件（文件内容与元数据一并删除）
  const stale = await env.DB.prepare(
    `DELETE FROM files
      WHERE created_at < ?
        AND ((scope = 'log' AND log_id IS NULL)
          OR (scope = 'reply' AND reply_id IS NULL)
          OR (scope = 'review' AND review_event_id IS NULL))
      RETURNING r2_key`,
  )
    .bind(now - 86400)
    .all<{ r2_key: string }>();
  // 任务说明附件可能在新建任务时先上传，留出更长的保存时间
  const staleTaskFiles = await env.DB.prepare(
    "DELETE FROM files WHERE scope = 'task' AND task_id IS NULL AND created_at < ? RETURNING r2_key",
  )
    .bind(now - 7 * 86400)
    .all<{ r2_key: string }>();
  // 资料附件同样可能在新建资料时先上传
  const staleShareFiles = await env.DB.prepare(
    "DELETE FROM files WHERE scope = 'share' AND share_id IS NULL AND created_at < ? RETURNING r2_key",
  )
    .bind(now - 7 * 86400)
    .all<{ r2_key: string }>();
  await deleteStoredObjects(env, [...stale.results, ...staleTaskFiles.results, ...staleShareFiles.results].map((row) => row.r2_key));
}

export default {
  fetch: app.fetch,
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(cleanup(env));
  },
} satisfies ExportedHandler<Env>;
