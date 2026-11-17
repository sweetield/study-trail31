import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useNavigate } from "react-router";
import useSWR, { mutate } from "swr";
import { AlertTriangle, Archive, Database, Download, FileJson, Upload } from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";
import { formatBytes } from "@/components/attachments";
import { Button, Card, CardHeader, Dialog, Field, Input, PageHeader } from "@/components/ui";

const TABLE_LABELS: Record<string, string> = {
  classes: "班级",
  users: "账号",
  tasks: "学习任务",
  task_classes: "任务班级",
  task_exclusions: "排除学员",
  task_steps: "任务步骤",
  progress: "学习进度",
  step_checks: "步骤打卡",
  study_logs: "学习日志",
  log_replies: "日志留言",
  progress_events: "审核历史",
  notifications: "站内通知",
  task_urges: "任务督促",
  audit_logs: "操作日志",
  app_settings: "系统设置",
};

interface BackupFile {
  format: string;
  version: number;
  exported_at: string;
  tables: Record<string, unknown[]>;
}

interface PendingRestore {
  fileName: string;
  backup: BackupFile;
}

interface PendingFullRestore {
  file: File;
}

type StorageBackend = "r2" | "kv";

interface DataStatus {
  empty: boolean;
  counts: { classes: number; students: number; tasks: number; progress: number; logs: number };
  storage: { available: StorageBackend[]; current: StorageBackend };
}

interface ArchivePreview {
  before: string;
  logs: number;
  oldest: string | null;
  files: number;
  bytes: number;
}

/** 默认归档 6 个月前的日志，符合“按学期清理”的使用习惯 */
function defaultArchiveDate() {
  const date = new Date();
  date.setMonth(date.getMonth() - 6);
  return date.toISOString().slice(0, 10);
}

const STORAGE_LABELS: Record<StorageBackend, string> = {
  r2: "R2 对象存储",
  kv: "KV 键值存储",
};

function parseBackup(text: string): BackupFile {
  const data = JSON.parse(text) as Partial<BackupFile>;
  if (data.format !== "xueji-backup" || !data.tables || typeof data.tables !== "object") {
    throw new Error("不是有效的学迹备份文件");
  }
  return data as BackupFile;
}

function TableCounts({ tables }: { tables: Record<string, unknown[]> }) {
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {Object.entries(TABLE_LABELS).map(([key, label]) => (
        <div key={key} className="rounded-lg bg-muted px-3 py-2">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="text-lg font-semibold tabular-nums">{Array.isArray(tables[key]) ? tables[key].length : 0}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function AdminDataPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  const fullFileInput = useRef<HTMLInputElement>(null);
  const { data: status } = useSWR<DataStatus>("/api/admin/data/status");
  const [exporting, setExporting] = useState(false);
  const [exportingFull, setExportingFull] = useState(false);
  const [pending, setPending] = useState<PendingRestore | null>(null);
  const [fullPending, setFullPending] = useState<PendingFullRestore | null>(null);
  const [password, setPassword] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [fullPassword, setFullPassword] = useState("");
  const [fullConfirmText, setFullConfirmText] = useState("");
  const [fullRestoring, setFullRestoring] = useState(false);
  const [archiveBefore, setArchiveBefore] = useState(defaultArchiveDate);
  const [archivePreview, setArchivePreview] = useState<ArchivePreview | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState("");
  const [archiving, setArchiving] = useState(false);
  const [archiveProgress, setArchiveProgress] = useState("");

  const availableBackends = status?.storage.available ?? [];
  const currentBackend = status?.storage.current ?? "r2";

  async function handleExport() {
    setExporting(true);
    try {
      const res = await fetch("/api/admin/data/export", { credentials: "same-origin" });
      if (!res.ok) throw new Error(`导出失败 (${res.status})`);
      const blob = await res.blob();
      const name = res.headers.get("content-disposition")?.match(/filename="(.+?)"/)?.[1] ?? "xueji-backup.json";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
      toast("备份文件已下载");
    } catch (err) {
      toast(err instanceof Error ? err.message : "导出失败", "error");
    } finally {
      setExporting(false);
    }
  }

  async function handleExportFull() {
    setExportingFull(true);
    try {
      const headers = await api.download("/api/admin/data/export-full", "xueji-full-backup.zip");
      const skipped = Number(headers.get("x-backup-skipped-archives") ?? 0);
      toast(
        skipped
          ? `完整备份已下载（包含账号、任务、日志、附件与头像；已跳过 ${skipped} 个超过 1 MB 的 7z / tar 压缩包）`
          : "完整备份已下载（包含账号、任务、日志、附件与头像）",
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : "导出备份失败", "error");
    } finally {
      setExportingFull(false);
    }
  }

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const backup = parseBackup(await file.text());
      setPassword("");
      setConfirmText("");
      setPending({ fileName: file.name, backup });
    } catch (err) {
      toast(err instanceof SyntaxError ? "文件不是有效的 JSON" : err instanceof Error ? err.message : "读取文件失败", "error");
    }
  }

  function handleFullFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) {
      toast("请选择系统导出的备份 .zip 文件", "error");
      return;
    }
    setFullPassword("");
    setFullConfirmText("");
    setFullPending({ file });
  }

  async function handleFullRestore(e: FormEvent) {
    e.preventDefault();
    if (!fullPending) return;
    setFullRestoring(true);
    try {
      const form = new FormData();
      form.set("password", fullPassword);
      form.set("file", fullPending.file);
      await api.upload("/api/admin/data/import-full", form);
      setFullPending(null);
      await mutate(() => true, undefined, { revalidate: false });
      await mutate("/api/auth/me", { user: null }, { revalidate: false });
      toast("备份已恢复，请使用备份中的账号重新登录");
      navigate("/login", { replace: true });
    } catch (err) {
      toast(err instanceof Error ? err.message : "恢复备份失败", "error");
    } finally {
      setFullRestoring(false);
    }
  }

  async function handleRestore(e: FormEvent) {
    e.preventDefault();
    if (!pending) return;
    setRestoring(true);
    try {
      await api.post("/api/admin/data/import", { password, backup: pending.backup });
      setPending(null);
      await mutate(() => true, undefined, { revalidate: false });
      await mutate("/api/auth/me", { user: null }, { revalidate: false });
      toast("数据已恢复，请使用备份中的账号重新登录");
      navigate("/login", { replace: true });
    } catch (err) {
      toast(err instanceof Error ? err.message : "恢复失败", "error");
    } finally {
      setRestoring(false);
    }
  }

  async function previewArchive() {
    try {
      const res = await api.get<ArchivePreview>(`/api/admin/data/archive?before=${archiveBefore}`);
      setArchivePreview(res);
      setArchiveConfirm("");
      setArchiveProgress("");
      setArchiveOpen(true);
    } catch (err) {
      toast(err instanceof Error ? err.message : "读取归档信息失败", "error");
    }
  }

  async function handleArchive(e: FormEvent) {
    e.preventDefault();
    if (!archivePreview) return;
    if (archiveConfirm !== "归档") {
      toast("请输入「归档」确认操作", "error");
      return;
    }
    setArchiving(true);
    let deletedLogs = 0;
    let deletedFiles = 0;
    let remaining = 0;
    try {
      // 服务端每次最多处理 50 条，循环到没有剩余数据为止
      for (let i = 0; i < 200; i++) {
        const res = await api.post<{ deleted_logs: number; deleted_files: number; remaining: number }>("/api/admin/data/archive", {
          before: archivePreview.before,
          confirm: "归档",
          limit: 50,
        });
        deletedLogs += res.deleted_logs;
        deletedFiles += res.deleted_files;
        remaining = res.remaining;
        setArchiveProgress(`已删除 ${deletedLogs} 条日志、${deletedFiles} 个附件，剩余 ${remaining} 条`);
        if (!remaining || !res.deleted_logs) break;
      }
      if (remaining > 0) {
        toast(`已归档 ${deletedLogs} 条日志、${deletedFiles} 个附件，仍有 ${remaining} 条未处理，可再次归档`, "error");
      } else {
        toast(`归档完成：删除 ${deletedLogs} 条日志、${deletedFiles} 个附件`);
      }
      setArchiveOpen(false);
      setArchivePreview(null);
      await mutate("/api/admin/data/status");
    } catch (err) {
      toast(err instanceof Error ? err.message : "归档失败", "error");
    } finally {
      setArchiving(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="数据备份" description="文字数据可用 JSON 备份快速迁移；需要连同图片、附件与头像一起保留时，请导出完整备份（ZIP）。" />

      {status && (status.empty || availableBackends.length > 0) && (
        <Card>
          <CardHeader
            title="文件存储"
            description="附件与头像保存在部署时绑定的 R2 或 KV 中，系统只使用一种存储；不支持在初始化或后台切换。"
          />
          {availableBackends.length ? (
            <div className="flex flex-col gap-2 px-5 py-4 text-sm text-muted-foreground">
              <p className="flex items-start gap-2">
                <Database className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>
                  当前部署使用 <span className="font-medium text-foreground">{STORAGE_LABELS[currentBackend]}</span>。
                  文字备份（JSON）不包含这些文件内容；完整备份（ZIP）会打包图片、其它附件与小于 1 MB 的 7z / tar 压缩包。
                </span>
              </p>
              {availableBackends.length > 1 && (
                <p className="text-warning">
                  当前部署同时绑定了 R2 与 KV。系统只会使用其中一种，建议在部署配置中仅保留需要的存储绑定。
                </p>
              )}
            </div>
          ) : (
            <p className="px-5 py-4 text-sm text-muted-foreground">当前部署未绑定文件存储，附件与头像功能不可用。</p>
          )}
        </Card>
      )}

      {status?.empty && (
        <Card className="border-warning/40 bg-warning-soft">
          <div className="flex items-start gap-3 px-5 py-4">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium">当前没有班级、学员或任务数据</p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                如果这是从旧版本重新部署，或数据库结构刚刚升级，请在下方导入之前导出的旧备份。JSON 备份会恢复班级、账号、任务、进度、打卡、日志、留言层级、任务督促、站内通知、操作日志与系统设置等文字数据；包含附件与头像的完整备份还会恢复图片、附件、头像以及小于 1 MB 的 7z / tar 压缩包。
              </p>
            </div>
          </div>
        </Card>
      )}

      <Card className="border-primary/30">
        <CardHeader
          title="导出完整备份（ZIP）"
          description="包含全部文字数据，以及学习日志、作品、任务说明、留言中的图片与附件和头像图片。7z / tar 压缩包中超过 1 MB 的部分默认不打包，小于 1 MB 的小压缩包会保留。适合重新部署或完整迁移。"
          action={
            <div className="flex flex-wrap gap-2">
              <Button onClick={handleExportFull} loading={exportingFull}>
                <Archive aria-hidden="true" />
                导出完整备份
              </Button>
              <Button variant="outline" onClick={() => fullFileInput.current?.click()}>
                <Upload aria-hidden="true" />
                导入备份
              </Button>
            </div>
          }
        />
        <div className="flex flex-col gap-2 px-5 py-4 text-sm text-muted-foreground">
          <p>备份文件是 .zip 格式，包含附件与头像的加密原始内容，需要和数据库中的加密密钥一起使用；备份文件中已包含该密钥。</p>
          <p>7z / tar 压缩包附件（含 .001 等分卷）中，超过 1 MB 的不会写入完整备份，恢复后需要重新上传；小于 1 MB 的小压缩包会随备份一起保留，其余图片与附件不受影响。</p>
          <p>恢复时会沿用当前部署绑定的文件存储（R2 或 KV），因此重新部署后请确认已经绑定对应的存储资源。单次备份最大 90 MB。</p>
          <p>仅需文字数据时请使用下方的 JSON 备份；旧版本导出的、不含附件与头像的 ZIP 备份仍然可以从这里导入。</p>
        </div>
        <input
          ref={fullFileInput}
          type="file"
          accept=".zip,application/zip"
          className="sr-only"
          onChange={handleFullFile}
          aria-label="选择备份 ZIP 文件"
          tabIndex={-1}
        />
      </Card>

      <Card>
        <CardHeader
          title="学期归档（可选）"
          description="删除指定日期之前的学习日志、留言与附件，控制长期使用后的数据量。操作不可撤销，建议先导出完整备份。"
        />
        <div className="flex flex-col gap-3 px-5 py-4 text-sm text-muted-foreground">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="归档此日期之前的日志" htmlFor="archive-before">
              <Input
                id="archive-before"
                type="date"
                value={archiveBefore}
                max={new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)}
                onChange={(e) => setArchiveBefore(e.target.value)}
                className="w-44"
              />
            </Field>
            <Button variant="outline" onClick={previewArchive}>
              <Archive aria-hidden="true" />
              预览可归档内容
            </Button>
          </div>
          <p>只删除学习日志及其留言、附件，不影响账号、任务与学习进度。为保留最近记录，归档日期不能晚于 30 天前。</p>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="导出文字备份（JSON）"
          description="仅包含班级、账号、任务详情、发布范围、学习进度、步骤打卡、学习日志、留言、审核历史、督促与操作日志等文字数据；不包含附件文件内容与头像图片，体积更小。"
          action={
            <Button onClick={handleExport} loading={exporting}>
              <Download aria-hidden="true" />
              导出 JSON
            </Button>
          }
        />
        <p className="px-5 py-4 text-sm text-muted-foreground">
          备份文件中含有账号的密码哈希（不是明文密码）与文件加密密钥，请妥善保管，不要公开分享。需要连同图片、附件与头像一起保留时，请使用上方的完整备份（ZIP）。
        </p>
      </Card>

      <Card>
        <CardHeader
          title="从 JSON 备份恢复"
          description="选择之前导出的 .json 备份文件，确认后会用备份内容覆盖当前全部文字数据。"
          action={
            <Button variant="outline" onClick={() => fileInput.current?.click()}>
              <Upload aria-hidden="true" />
              选择 JSON 文件
            </Button>
          }
        />
        <div className="flex items-start gap-3 px-5 py-4 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <p className="text-muted-foreground">
            JSON 恢复会用备份中的账号、任务、进度、日志等文字记录覆盖当前数据，附件与头像不会恢复，所有用户都需要重新登录。需要恢复图片、附件与头像时，请使用上方的 ZIP 完整备份。
          </p>
        </div>
        <input ref={fileInput} type="file" accept="application/json,.json" className="sr-only" onChange={handleFile} aria-label="选择备份文件" tabIndex={-1} />
      </Card>

      <Dialog open={!!pending} onClose={() => !restoring && setPending(null)} title="确认恢复数据" description="当前全部数据将被备份内容覆盖，此操作无法撤销。">
        {pending && (
          <form onSubmit={handleRestore} className="flex flex-col gap-4">
            <div className="flex items-center gap-2 text-sm">
              <FileJson className="size-4 text-muted-foreground" aria-hidden="true" />
              <span className="truncate font-medium">{pending.fileName}</span>
              <span className="shrink-0 text-muted-foreground">
                {Number.isNaN(Date.parse(pending.backup.exported_at)) ? "" : `导出于 ${new Date(pending.backup.exported_at).toLocaleString("zh-CN")}`}
              </span>
            </div>
            <TableCounts tables={pending.backup.tables} />
            <Field label="当前管理员密码" htmlFor="restore-password">
              <Input id="restore-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <Field label="请输入「确认恢复」以继续" htmlFor="restore-confirm">
              <Input id="restore-confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" required />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPending(null)} disabled={restoring}>
                取消
              </Button>
              <Button type="submit" variant="destructive" loading={restoring} disabled={!password || confirmText.trim() !== "确认恢复"}>
                覆盖并恢复
              </Button>
            </div>
          </form>
        )}
      </Dialog>

      <Dialog
        open={!!fullPending}
        onClose={() => !fullRestoring && setFullPending(null)}
        title="确认恢复备份"
        description="当前全部数据、附件与头像都会被备份内容覆盖，此操作无法撤销。"
      >
        {fullPending && (
          <form onSubmit={handleFullRestore} className="flex flex-col gap-4">
            <div className="flex items-center gap-2 text-sm">
              <Archive className="size-4 text-muted-foreground" aria-hidden="true" />
              <span className="truncate font-medium">{fullPending.file.name}</span>
              <span className="shrink-0 text-muted-foreground">{formatBytes(fullPending.file.size)}</span>
            </div>
            <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
              如果备份包含附件与头像，当前部署需要已绑定 R2 或 KV（只需一种），并会使用当前部署绑定的文件存储保存恢复出来的图片与文件；仅含文字数据的备份不需要文件存储。
            </p>
            <Field label="当前管理员密码" htmlFor="restore-full-password">
              <Input
                id="restore-full-password"
                type="password"
                autoComplete="current-password"
                value={fullPassword}
                onChange={(e) => setFullPassword(e.target.value)}
                required
              />
            </Field>
            <Field label="请输入「确认恢复」以继续" htmlFor="restore-full-confirm">
              <Input
                id="restore-full-confirm"
                value={fullConfirmText}
                onChange={(e) => setFullConfirmText(e.target.value)}
                autoComplete="off"
                required
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setFullPending(null)} disabled={fullRestoring}>
                取消
              </Button>
              <Button
                type="submit"
                variant="destructive"
                loading={fullRestoring}
                disabled={!fullPassword || fullConfirmText.trim() !== "确认恢复"}
              >
                覆盖并恢复
              </Button>
            </div>
          </form>
        )}
      </Dialog>

      <Dialog
        open={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        title="确认学期归档"
        description="删除后不可撤销，建议先导出完整备份。"
      >
        {archivePreview && (
          <form onSubmit={handleArchive} className="flex flex-col gap-3 text-sm">
            <div className="rounded-lg bg-destructive-soft px-4 py-3 text-destructive">
              <p className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>
                  将永久删除 <span className="font-semibold tabular-nums">{archivePreview.before}</span> 之前的
                  <span className="font-semibold tabular-nums"> {archivePreview.logs} </span>条学习日志、对应的留言与
                  <span className="font-semibold tabular-nums"> {archivePreview.files} </span>个附件（约{" "}
                  {formatBytes(archivePreview.bytes)}）。
                </span>
              </p>
            </div>
            <dl className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-muted px-3 py-2">
                <dt className="text-xs text-muted-foreground">日志条数</dt>
                <dd className="text-lg font-semibold tabular-nums">{archivePreview.logs}</dd>
              </div>
              <div className="rounded-lg bg-muted px-3 py-2">
                <dt className="text-xs text-muted-foreground">附件数量</dt>
                <dd className="text-lg font-semibold tabular-nums">{archivePreview.files}</dd>
              </div>
              <div className="rounded-lg bg-muted px-3 py-2">
                <dt className="text-xs text-muted-foreground">附件体积</dt>
                <dd className="text-lg font-semibold tabular-nums">{formatBytes(archivePreview.bytes)}</dd>
              </div>
              <div className="rounded-lg bg-muted px-3 py-2">
                <dt className="text-xs text-muted-foreground">最早日志</dt>
                <dd className="text-lg font-semibold tabular-nums">{archivePreview.oldest ?? "—"}</dd>
              </div>
            </dl>
            {archivePreview.logs === 0 ? (
              <p className="text-muted-foreground">这个日期之前没有学习日志，无需归档。</p>
            ) : (
              <>
                <Field label="请输入「归档」以确认" htmlFor="archive-confirm">
                  <Input
                    id="archive-confirm"
                    value={archiveConfirm}
                    onChange={(e) => setArchiveConfirm(e.target.value)}
                    autoComplete="off"
                    required
                  />
                </Field>
                {archiveProgress && <p className="text-xs text-muted-foreground">{archiveProgress}</p>}
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setArchiveOpen(false)} disabled={archiving}>
                    取消
                  </Button>
                  <Button
                    type="submit"
                    variant="destructive"
                    loading={archiving}
                    disabled={archiveConfirm.trim() !== "归档"}
                  >
                    确认归档
                  </Button>
                </div>
              </>
            )}
          </form>
        )}
      </Dialog>
    </div>
  );
}
