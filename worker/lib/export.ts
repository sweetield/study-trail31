import type { Env } from "../types";
import { decryptFile, getStoredObject } from "./storage";
import { applyLocalFilePaths } from "./markdown";
import { createZip, type ZipEntry } from "./zip";

export interface ExportAttachment {
  id: string;
  name: string;
}

/** 导出文件名中不允许出现的字符，统一替换为下划线 */
function safeExportName(name: string): string {
  return (
    name
      .replace(/[\u0000-\u001f\u007f\\/:*?"<>|#%]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "未命名"
  );
}

/**
 * 生成「前缀_名称_日期」形式的导出名。
 * 单篇 / 单个任务使用实际名称；批量导出时使用首项名称 + 数量，避免文件名过长。
 */
export function exportFileBase(prefix: string, names: string[], stamp: string, emptyLabel: string, measure: string): string {
  const unique = [...new Set(names.map(safeExportName).filter(Boolean))];
  if (!unique.length) return `${prefix}_${emptyLabel}_${stamp}`;
  const label = unique.length === 1 ? unique[0] : `${unique[0]}等${unique.length}${measure}`;
  return `${prefix}_${label}_${stamp}`;
}

/** 单次导出打包的附件总大小上限，避免 Worker 内存被过大的附件占满 */
const MAX_EXPORT_ATTACHMENT_BYTES = 90 * 1024 * 1024;

function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "附件";
  return (
    base
      .replace(/[\u0000-\u001f\u007f:*?"<>|#%]/g, "_")
      .trim()
      .slice(0, 140) || "附件"
  );
}

/**
 * 把 Markdown 导出与相关附件一起打包为 ZIP：
 * - Markdown 中所有 /api/files/:id 链接都改写为压缩包内的相对路径；
 * - 图片、压缩包等附件以本地文件形式放入「附件」目录；
 * - 返回的 ZIP 可以直接解压查看，不再依赖线上文件链接。
 */
export async function packageExport(
  env: Env,
  markdown: string,
  markdownName: string,
  files: ExportAttachment[],
): Promise<Uint8Array<ArrayBuffer>> {
  const unique = new Map<string, ExportAttachment>();
  for (const file of files) {
    if (file?.id && !unique.has(file.id)) unique.set(file.id, file);
  }

  const ids = [...unique.keys()];
  const rows = new Map<string, { id: string; r2_key: string; iv: string; size: number }>();
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const { results } = await env.DB.prepare(
      `SELECT id, r2_key, iv, size FROM files WHERE id IN (${chunk.map(() => "?").join(", ")})`,
    )
      .bind(...chunk)
      .all<{ id: string; r2_key: string; iv: string; size: number }>();
    for (const row of results) rows.set(row.id, row);
  }

  const paths = new Map<string, string>();
  const entries: ZipEntry[] = [];
  let total = 0;
  let skipped = 0;

  for (const [id, file] of unique) {
    const row = rows.get(id);
    if (!row || total + row.size > MAX_EXPORT_ATTACHMENT_BYTES) {
      skipped += 1;
      continue;
    }
    const object = await getStoredObject(env, row.r2_key);
    if (!object) {
      skipped += 1;
      continue;
    }
    let data: ArrayBuffer;
    try {
      data = await decryptFile(env, row, object);
    } catch {
      skipped += 1;
      continue;
    }
    if (total + data.byteLength > MAX_EXPORT_ATTACHMENT_BYTES) {
      skipped += 1;
      continue;
    }
    total += data.byteLength;
    const path = `附件/${id.slice(0, 8)}_${safeFileName(file.name)}`;
    paths.set(id, path.split("/").map(encodeURIComponent).join("/"));
    entries.push({ name: path, data: new Uint8Array(data) });
  }

  let md = applyLocalFilePaths(markdown, paths);
  if (skipped) md += `\n\n> 注意：有 ${skipped} 个附件因文件体积过大或内容缺失未打包。\n`;

  entries.unshift({ name: markdownName, data: new TextEncoder().encode(md) });
  return createZip(entries);
}
