import { Hono } from "hono";
import type { AppEnv } from "../types";
import { requireAuth } from "../lib/session";
import { HttpError, int } from "../lib/validate";
import { SHARE_STUDENT_VISIBLE, assertShareVisible } from "../lib/share-audience";
import { buildShareMarkdown, parseShareIds } from "../lib/markdown";
import { packageExport, exportFileBase, type ExportAttachment } from "../lib/export";

export const shareRoutes = new Hono<AppEnv>();
shareRoutes.use("*", requireAuth);

/** 当前用户可见的资料列表：列表只返回摘要和统计，正文按需在详情页加载 */
shareRoutes.get("/", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const visible = user.role === "admin" ? "s.status = 'published'" : SHARE_STUDENT_VISIBLE;
  const binds = user.role === "admin" ? [] : [user.id, user.class_id];
  const { results } = await db
    .prepare(
      `SELECT s.id, s.title, s.tech_tags, s.pinned, s.view_count, s.created_at, s.updated_at,
              substr(s.description, 1, 200) AS excerpt,
              (SELECT u.name FROM users u WHERE u.id = s.created_by) AS creator_name,
              (SELECT COUNT(*) FROM files f WHERE f.scope = 'share' AND f.share_id = s.id) AS file_count
         FROM shares s
        WHERE ${visible}
        ORDER BY s.pinned DESC, s.created_at DESC, s.id DESC`,
    )
    .bind(...binds)
    .all();
  return c.json({ shares: results });
});

/** 批量导出当前用户可见的资料：正文写入 Markdown，附件一并打包为 ZIP */
shareRoutes.get("/export", async (c) => {
  const user = c.get("user");
  const origin = new URL(c.req.url).origin;
  const ids = parseShareIds(c.req.query("share_ids"));
  const isAdmin = user.role === "admin";
  const visible = isAdmin ? "s.status = 'published'" : SHARE_STUDENT_VISIBLE;
  const binds: (number | null)[] = isAdmin ? [] : [user.id, user.class_id];
  const idFilter = ids.length ? ` AND s.id IN (${ids.map((_, i) => `?${binds.length + i + 1}`).join(", ")})` : "";
  const stmt = c.env.DB.prepare(
    `SELECT s.id, s.title, s.description, s.tech_tags, s.status, s.audience_all, s.pinned,
            s.view_count, s.created_at, s.updated_at,
            (SELECT u.name FROM users u WHERE u.id = s.created_by) AS creator_name,
            (SELECT GROUP_CONCAT(c.name, '、') FROM share_classes sc JOIN classes c ON c.id = sc.class_id WHERE sc.share_id = s.id) AS class_names
       FROM shares s
      WHERE ${visible}${idFilter}
      ORDER BY s.pinned DESC, s.created_at DESC, s.id DESC`,
  );
  const { results: shares } = await (binds.length || ids.length ? stmt.bind(...binds, ...ids) : stmt).all<{
    id: number;
    title: string;
    description: string;
    tech_tags: string;
    status: string;
    audience_all: number;
    pinned: number;
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
    user.name,
    shares.map((share) => ({ ...share, files: fileMap.get(share.id) ?? [] })),
    origin,
    isAdmin ? "admin" : "student",
  );
  const zip = await packageExport(c.env, md, mdName, exportFiles);
  return c.body(zip, 200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="study-trail-shares-${stamp}.zip"; filename*=UTF-8''${encodeURIComponent(`${base}.zip`)}`,
    "Content-Length": String(zip.byteLength),
  });
});

shareRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  const id = int(c.req.param("id"), "资料ID")!;
  const row = await assertShareVisible(c.env, id, user);
  const db = c.env.DB;
  const [shareRes, filesRes] = await db.batch([
    db.prepare(
      `SELECT s.id, s.title, s.description, s.tech_tags, s.status, s.audience_all, s.pinned,
              s.view_count, s.created_at, s.updated_at,
              (SELECT u.name FROM users u WHERE u.id = s.created_by) AS creator_name,
              (SELECT a.id FROM avatars a WHERE a.user_id = s.created_by) AS creator_avatar_id,
              (SELECT GROUP_CONCAT(c.name, '、') FROM share_classes sc JOIN classes c ON c.id = sc.class_id WHERE sc.share_id = s.id) AS class_names
         FROM shares s WHERE s.id = ?`,
    ).bind(id),
    db.prepare("SELECT id, uploader_id, name, mime, size, created_at FROM files WHERE scope = 'share' AND share_id = ? ORDER BY created_at, id").bind(id),
  ]);
  const share = shareRes.results[0] as Record<string, unknown> | undefined;
  if (!share) throw new HttpError(404, "资料不存在");

  // 访问量按学员首次打开计数；辅导员预览不计入，避免管理操作抬高数据。
  let viewCount = Number(share.view_count ?? 0);
  if (user.role === "student" && row.status === "published") {
    const inserted = await db
      .prepare("INSERT OR IGNORE INTO share_views (share_id, user_id) VALUES (?, ?) RETURNING share_id")
      .bind(id, user.id)
      .first<{ share_id: number }>();
    if (inserted) {
      await db.prepare("UPDATE shares SET view_count = view_count + 1 WHERE id = ?").bind(id).run();
      viewCount += 1;
    }
  }

  return c.json({
    share: { ...share, view_count: viewCount },
    files: filesRes.results,
  });
});
