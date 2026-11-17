import type { Env } from "../types";
import { HttpError } from "./validate";

/**
 * 资料分享可见范围：
 * - shares.audience_all = 1：面向全部学员
 * - audience_all = 0 且 share_classes 有记录：仅这些班级
 * - share_exclusions 中的学员始终排除
 *
 * 与任务的 audienceSql 分开实现，避免资料功能改动任务查询。
 */
export function shareAudienceSql(shareAlias = "s", userAlias = "u"): string {
  return `(
    ${shareAlias}.audience_all = 1
    OR EXISTS (
      SELECT 1 FROM share_classes sc
       WHERE sc.share_id = ${shareAlias}.id AND sc.class_id = ${userAlias}.class_id
    )
  ) AND NOT EXISTS (
    SELECT 1 FROM share_exclusions se
     WHERE se.share_id = ${shareAlias}.id AND se.user_id = ${userAlias}.id
  )`;
}

/** 当前登录学员可见的已发布资料条件（?1 = user.id，?2 = user.class_id） */
export const SHARE_STUDENT_VISIBLE = `s.status = 'published' AND (
  s.audience_all = 1
  OR EXISTS (SELECT 1 FROM share_classes sc WHERE sc.share_id = s.id AND sc.class_id = ?2)
) AND NOT EXISTS (
  SELECT 1 FROM share_exclusions se WHERE se.share_id = s.id AND se.user_id = ?1
)`;

export async function loadShareAudience(env: Env, shareId: number): Promise<{ classIds: number[]; excludedUserIds: number[] }> {
  const [classes, excluded] = await env.DB.batch([
    env.DB.prepare("SELECT class_id FROM share_classes WHERE share_id = ? ORDER BY class_id").bind(shareId),
    env.DB.prepare("SELECT user_id FROM share_exclusions WHERE share_id = ? ORDER BY user_id").bind(shareId),
  ]);
  return {
    classIds: (classes.results as { class_id: number }[]).map((row) => row.class_id),
    excludedUserIds: (excluded.results as { user_id: number }[]).map((row) => row.user_id),
  };
}

export async function shareAudienceUserIds(env: Env, shareId: number): Promise<number[]> {
  const { results } = await env.DB.prepare(
    `SELECT u.id FROM users u JOIN shares s ON s.id = ?
      WHERE u.role = 'student' AND u.active = 1 AND ${shareAudienceSql("s", "u")}`,
  )
    .bind(shareId)
    .all<{ id: number }>();
  return results.map((row) => row.id);
}

/** 分批写入资料发布通知，避免单次 batch 语句过多 */
export async function notifyShareUsers(env: Env, userIds: number[], title: string, shareId: number): Promise<void> {
  if (!userIds.length) return;
  const link = `/s/${shareId}`;
  for (let i = 0; i < userIds.length; i += 50) {
    const chunk = userIds.slice(i, i + 50);
    await env.DB.batch(
      chunk.map((userId) => env.DB.prepare("INSERT INTO notifications (user_id, kind, title, link) VALUES (?, 'share', ?, ?)").bind(userId, title, link)),
    );
  }
}

/** 生成替换发布范围的 SQL 语句，与资料写入放在同一批次中 */
export function shareAudienceStatements(
  db: D1Database,
  shareId: number,
  classIds: number[],
  excludedUserIds: number[],
): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM share_classes WHERE share_id = ?").bind(shareId),
    db.prepare("DELETE FROM share_exclusions WHERE share_id = ?").bind(shareId),
    ...classIds.map((classId) => db.prepare("INSERT INTO share_classes (share_id, class_id) VALUES (?, ?)").bind(shareId, classId)),
    ...excludedUserIds.map((userId) => db.prepare("INSERT INTO share_exclusions (share_id, user_id) VALUES (?, ?)").bind(shareId, userId)),
  ];
}

/**
 * 校验当前用户是否可以查看某篇资料。
 * 管理员始终可见；学员需要已发布且在班级 / 排除名单范围内。
 */
export async function assertShareVisible(
  env: Env,
  shareId: number,
  user: { id: number; role: "admin" | "student"; class_id: number | null },
): Promise<{ id: number; status: string; title: string }> {
  const row = await env.DB.prepare(
    `SELECT s.id, s.status, s.title
       FROM shares s
      WHERE s.id = ? AND (
        ?3 = 'admin'
        OR (s.status = 'published'
            AND (
              s.audience_all = 1
              OR EXISTS (SELECT 1 FROM share_classes sc WHERE sc.share_id = s.id AND sc.class_id = ?4)
            )
            AND NOT EXISTS (SELECT 1 FROM share_exclusions se WHERE se.share_id = s.id AND se.user_id = ?2))
      )`,
  )
    .bind(shareId, user.id, user.role, user.class_id)
    .first<{ id: number; status: string; title: string }>();
  if (!row) throw new HttpError(404, "资料不存在或未向你开放");
  return row;
}
