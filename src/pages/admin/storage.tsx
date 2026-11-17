import { useDeferredValue, useState } from "react";
import { Link } from "react-router";
import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import { AlertTriangle, Database, HardDrive, RefreshCw, Search, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import type { AdminStorageData, StorageFileItem, StorageFilePage, StorageScopeUsage, StorageStudentUsage } from "@/lib/types";
import { fileUrl, formatBytes } from "@/components/attachments";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, CardHeader, EmptyState, Input, PageHeader, PageLoader, ProgressBar, Select, StatCard } from "@/components/ui";
import { cn, formatTime } from "@/lib/utils";

const SCOPE_ORDER = ["log", "progress", "task", "review", "reply", "share"] as const;
const SCOPE_LABELS: Record<string, string> = {
  log: "学习日志附件",
  progress: "作品附件",
  task: "任务说明附件",
  review: "审核批注",
  reply: "留言附件",
  share: "分享资料附件",
};

function fileTarget(file: StorageFileItem): { label: string; to: string } | null {
  if (file.scope === "task") return file.task_id ? { label: "查看任务", to: `/admin/tasks/${file.task_id}` } : null;
  if (file.scope === "share") return file.share_id ? { label: "查看资料", to: `/admin/shares/${file.share_id}` } : null;
  if (file.scope === "progress") return file.task_id ? { label: "查看任务", to: `/admin/tasks/${file.task_id}` } : null;
  if (file.scope === "log" || file.scope === "reply" || file.scope === "review") {
    return { label: "查看学员", to: `/admin/students/${file.owner_user_id}` };
  }
  return null;
}

function quotaTone(percent: number): "primary" | "warning" {
  return percent >= 80 ? "warning" : "primary";
}

function ScopeRow({ item, max }: { item: StorageScopeUsage; max: number }) {
  const percent = max > 0 ? (item.bytes / max) * 100 : 0;
  return (
    <div className="flex flex-col gap-1.5 py-2">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{SCOPE_LABELS[item.scope] ?? item.scope}</span>
        <span className="tabular-nums text-muted-foreground">
          {formatBytes(item.bytes)} · {item.count} 个文件
        </span>
      </div>
      <ProgressBar value={percent} tone={item.bytes ? "primary" : "muted"} label={`${SCOPE_LABELS[item.scope] ?? item.scope}占用`} />
    </div>
  );
}

export default function AdminStoragePage() {
  const { data, error, mutate: mutateStorage, isValidating } = useSWR<AdminStorageData>("/api/admin/storage");
  const [query, setQuery] = useState("");
  const [classFilter, setClassFilter] = useState("");
  const [onlyUsed, setOnlyUsed] = useState(false);
  const q = useDeferredValue(query.trim().toLowerCase());

  const [fileScope, setFileScope] = useState("");
  const [fileClass, setFileClass] = useState("");
  const [fileOwner, setFileOwner] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const [fileSort, setFileSort] = useState<"size" | "created">("size");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const fileQ = useDeferredValue(fileQuery.trim());
  const toast = useToast();

  const fileKey = (pageIndex: number, previous: StorageFilePage | null) => {
    if (previous && !previous.has_more) return null;
    const params = new URLSearchParams();
    if (fileScope) params.set("scope", fileScope);
    if (fileClass) params.set("class_id", fileClass);
    if (fileOwner) params.set("owner_id", fileOwner);
    if (fileQ) params.set("q", fileQ);
    params.set("sort", fileSort);
    if (pageIndex > 0 && previous?.next_cursor) params.set("cursor", previous.next_cursor);
    return `/api/admin/storage/files?${params.toString()}`;
  };
  const {
    data: filePages,
    size: filePageCount,
    setSize: setFilePageCount,
    isLoading: filesLoading,
    isValidating: filesValidating,
    error: filesError,
    mutate: mutateFiles,
  } = useSWRInfinite<StorageFilePage>(fileKey);

  if (!data) {
    if (error) {
      return (
        <div className="flex flex-col gap-5">
          <PageHeader title="存储用量" description="查看服务器容量与每位学员的附件占用。" />
          <Card>
            <EmptyState
              icon={<AlertTriangle />}
              title="读取存储用量失败"
              description={error instanceof Error ? error.message : "请稍后刷新重试"}
              action={<Button onClick={() => mutateStorage()}>重新加载</Button>}
            />
          </Card>
        </div>
      );
    }
    return <PageLoader />;
  }

  const storage = data.storage;
  const usedPercent = storage.total_bytes > 0 ? (storage.used_bytes / storage.total_bytes) * 100 : 0;
  const overCapacity = storage.used_bytes > storage.total_bytes;

  const classes = [...new Set(data.students.map((s) => s.class_name).filter((name): name is string => !!name))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const students = data.students.filter((s) => {
    if (classFilter && (s.class_name ?? "") !== classFilter) return false;
    if (onlyUsed && s.total_bytes === 0) return false;
    if (!q) return true;
    return s.name.toLowerCase().includes(q) || s.username.toLowerCase().includes(q);
  });

  const scopeMap = new Map(data.scopes.map((item) => [item.scope, item]));
  const scopes = SCOPE_ORDER.map((scope) => scopeMap.get(scope) ?? { scope, bytes: 0, count: 0 });
  const maxScopeBytes = Math.max(...scopes.map((item) => item.bytes), 1);

  const files = filePages?.flatMap((page) => page.files) ?? [];
  const hasMore = filePages?.at(-1)?.has_more ?? false;
  const selectedBytes = files.reduce((sum, file) => (selected.has(file.id) ? sum + file.size : sum), 0);
  const allLoadedSelected = files.length > 0 && files.every((file) => selected.has(file.id));
  const fileClasses = [
    ...new Map(
      data.students
        .filter((s) => s.class_id !== null && s.class_name)
        .map((s) => [s.class_id as number, s.class_name as string] as const),
    ).entries(),
  ].sort((a, b) => a[1].localeCompare(b[1], "zh-CN"));
  const ownerOptions = data.students.filter((s) => !fileClass || String(s.class_id ?? "") === fileClass);

  function resetFilePages() {
    setSelected(new Set());
    setFilePageCount(1);
  }

  function toggleFile(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllFiles() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allLoadedSelected) {
        for (const file of files) next.delete(file.id);
      } else {
        for (const file of files) next.add(file.id);
      }
      return next;
    });
  }

  function clearFileFilters() {
    setFileScope("");
    setFileClass("");
    setFileOwner("");
    setFileQuery("");
    resetFilePages();
  }

  function focusOwnerFiles(student: StorageStudentUsage) {
    setFileClass(student.class_id ? String(student.class_id) : "");
    setFileOwner(String(student.id));
    resetFilePages();
    document.getElementById("storage-files")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function deleteFiles(ids: string[], knownBytes?: number) {
    if (!ids.length || deleting) return;
    if (ids.length > 100) {
      toast("单次最多删除 100 个文件，请分批操作", "error");
      return;
    }
    const bytes = knownBytes ?? files.reduce((sum, file) => (ids.includes(file.id) ? sum + file.size : sum), 0);
    const sharedOrTask = files.some((file) => ids.includes(file.id) && (file.scope === "task" || file.scope === "share"));
    const extra = sharedOrTask ? "\n其中包含任务说明或资料附件，删除后学员将无法下载。" : "";
    if (!confirm(`确定删除 ${ids.length} 个文件吗？\n共 ${formatBytes(bytes)}，删除后无法恢复；正文中引用这些附件的链接也会失效。${extra}`)) return;
    setDeleting(true);
    try {
      const result = await api.post<{ ok: boolean; count: number; bytes: number }>("/api/admin/storage/files/delete", { ids });
      toast(`已删除 ${result.count} 个文件，释放 ${formatBytes(result.bytes)}`);
      setSelected(new Set());
      // 删除会改变分页边界，回到第一页重新加载，避免游标页之间出现重复
      setFilePageCount(1);
      await Promise.allSettled([mutateFiles(), mutateStorage()]);
    } catch (err) {
      toast(err instanceof Error ? err.message : "删除文件失败", "error");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="存储用量"
        description="查看当前部署的附件与头像占用，按学员核对配额，并清理不再需要的文件。"
        action={
          <Button
            variant="outline"
            onClick={() => {
              void mutateStorage();
              void mutateFiles();
            }}
            loading={isValidating || filesValidating}
          >
            <RefreshCw /> 刷新
          </Button>
        }
      />

      {!storage.backend && (
        <Card className="border-warning/40 bg-warning-soft">
          <div className="flex items-start gap-3 px-5 py-4 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
            <p className="text-muted-foreground">
              当前部署未绑定文件存储（R2 或 KV），附件与头像功能不可用，下面的统计只反映数据库中的历史记录。
            </p>
          </div>
        </Card>
      )}

      {overCapacity && (
        <Card className="border-warning/40 bg-warning-soft">
          <div className="flex items-start gap-3 px-5 py-4 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
            <p className="text-muted-foreground">
              已用空间超过当前显示容量上限。容量上限仅为管理端展示口径，超出后 Cloudflare 会按实际用量计费，请及时清理旧附件或调整配额。
            </p>
          </div>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="已用空间"
          value={formatBytes(storage.used_bytes)}
          hint={`${storage.file_count} 个附件 · ${storage.avatar_count} 个头像`}
          icon={<HardDrive />}
        />
        <StatCard
          label="剩余空间"
          value={formatBytes(storage.free_bytes)}
          hint={overCapacity ? "已超出容量上限" : `约占 ${Math.min(100, usedPercent).toFixed(1)}%`}
          icon={<Database />}
        />
        <StatCard
          label="容量上限"
          value={formatBytes(storage.total_bytes)}
          hint={storage.total_source === "env" ? "来自 STORAGE_TOTAL_MB 配置" : "默认按免费额度估算"}
        />
        <StatCard
          label="使用率"
          value={`${usedPercent.toFixed(1)}%`}
          hint={<ProgressBar value={usedPercent} tone={usedPercent >= 80 ? "warning" : "primary"} className="mt-1" label="容量使用率" />}
        />
      </div>

      <Card>
        <CardHeader
          title="服务器容量"
          description={`当前存储：${storage.label}。容量上限可在部署配置中通过 STORAGE_TOTAL_MB 调整。`}
        />
        <div className="flex flex-col gap-4 px-5 py-4">
          <div>
            <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="font-medium">
                {formatBytes(storage.used_bytes)} / {formatBytes(storage.total_bytes)}
              </span>
              <span className="tabular-nums text-muted-foreground">{usedPercent.toFixed(1)}%</span>
            </div>
            <ProgressBar value={usedPercent} tone={overCapacity || usedPercent >= 80 ? "warning" : "primary"} label="服务器容量使用率" />
          </div>
          <div className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
            <p>
              附件占用 <span className="font-medium text-foreground">{formatBytes(storage.attachment_bytes)}</span>
            </p>
            <p>
              头像占用 <span className="font-medium text-foreground">{formatBytes(storage.avatar_bytes)}</span>
            </p>
            <p>
              单条日志 / 任务 / 留言 / 审核上限{" "}
              <span className="font-medium text-foreground">{formatBytes(storage.scope_quota_bytes)}</span>
            </p>
            <p>
              单个学员上限 <span className="font-medium text-foreground">{formatBytes(storage.student_quota_bytes)}</span>
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            这里只统计 R2 / KV 中的附件与头像，不包含同一存储桶中的其他文件；D1 仅保存文字与附件元数据，容量占用很小。实际账单以 Cloudflare 控制台为准，建议在用量接近容量上限前清理旧附件。
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader title="按类型统计" description="全部附件按作用域汇总，便于发现占用较大的内容。" />
        <div className="divide-y px-5 py-2">
          {scopes.map((item) => (
            <ScopeRow key={item.scope} item={item} max={maxScopeBytes} />
          ))}
        </div>
      </Card>

      <Card id="storage-files" className="overflow-hidden">
        <CardHeader
          title="文件明细"
          description={`共 ${storage.file_count} 个附件；按占用或上传时间查看，可勾选删除不再需要的文件。列表直接读取 D1 元数据，不会扫描 R2 / KV。`}
          action={
            <Select
              value={fileSort}
              onChange={(e) => {
                setFileSort(e.target.value as "size" | "created");
                resetFilePages();
              }}
              className="w-44"
              aria-label="文件排序方式"
            >
              <option value="size">占用从大到小</option>
              <option value="created">最新上传优先</option>
            </Select>
          }
        />
        <div className="flex flex-col gap-3 border-b px-5 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-56 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                value={fileQuery}
                onChange={(e) => {
                  setFileQuery(e.target.value);
                  resetFilePages();
                }}
                placeholder="搜索文件名"
                className="pl-9"
                aria-label="搜索文件名"
              />
            </div>
            <Select
              value={fileScope}
              onChange={(e) => {
                setFileScope(e.target.value);
                resetFilePages();
              }}
              className="sm:w-40"
              aria-label="按文件类型筛选"
            >
              <option value="">全部类型</option>
              {SCOPE_ORDER.map((scope) => (
                <option key={scope} value={scope}>
                  {SCOPE_LABELS[scope]}
                </option>
              ))}
            </Select>
            {fileClasses.length > 0 && (
              <Select
                value={fileClass}
                onChange={(e) => {
                  setFileClass(e.target.value);
                  setFileOwner("");
                  resetFilePages();
                }}
                className="sm:w-40"
                title="按文件所属人的班级筛选"
                aria-label="按班级筛选文件"
              >
                <option value="">全部班级</option>
                {fileClasses.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </Select>
            )}
            <Select
              value={fileOwner}
              onChange={(e) => {
                setFileOwner(e.target.value);
                resetFilePages();
              }}
              className="sm:w-44"
              aria-label="按学员筛选文件"
            >
              <option value="">全部学员</option>
              {ownerOptions.map((student) => (
                <option key={student.id} value={student.id}>
                  {student.name}
                </option>
              ))}
            </Select>
            {(fileScope || fileClass || fileOwner || fileQuery) && (
              <Button variant="ghost" size="sm" onClick={clearFileFilters}>
                清除筛选
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-muted-foreground">
              已加载 {files.length} 个文件
              {selected.size > 0 && (
                <>
                  {" · 已选 "}
                  <span className="font-medium text-foreground">{selected.size}</span> 个，共 {formatBytes(selectedBytes)}
                </>
              )}
            </span>
            {selected.size > 0 &&
              (selected.size > 100 ? (
                <span className="text-xs text-destructive">单次最多删除 100 个，请先取消部分选择</span>
              ) : (
                <Button variant="destructive" size="sm" loading={deleting} onClick={() => void deleteFiles([...selected])}>
                  <Trash2 /> 删除所选
                </Button>
              ))}
          </div>
        </div>

        {filesError ? (
          <EmptyState
            icon={<AlertTriangle />}
            title="读取文件明细失败"
            description={filesError instanceof Error ? filesError.message : "请稍后刷新重试"}
            action={<Button onClick={() => void mutateFiles()}>重新加载</Button>}
          />
        ) : filesLoading && !files.length ? (
          <PageLoader />
        ) : files.length ? (
          <div className="max-h-[640px] overflow-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead className="sticky top-0 z-10 border-b bg-muted text-left text-xs text-muted-foreground">
                <tr>
                  <th className="w-10 px-5 py-2.5">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={allLoadedSelected}
                      onChange={toggleAllFiles}
                      aria-label="全选当前已加载文件"
                    />
                  </th>
                  <th className="px-3 py-2.5 font-medium">文件</th>
                  <th className="px-3 py-2.5 font-medium">类型</th>
                  <th className="px-3 py-2.5 font-medium">所属人</th>
                  <th className="px-3 py-2.5 font-medium">大小</th>
                  <th className="px-3 py-2.5 font-medium">上传时间</th>
                  <th className="px-3 py-2.5 font-medium">关联</th>
                  <th className="px-5 py-2.5 font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {files.map((file) => {
                  const target = fileTarget(file);
                  return (
                    <tr key={file.id} className={cn("hover:bg-muted/40", selected.has(file.id) && "bg-muted/60")}>
                      <td className="px-5 py-3">
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked={selected.has(file.id)}
                          onChange={() => toggleFile(file.id)}
                          aria-label={`选择 ${file.name}`}
                        />
                      </td>
                      <td className="max-w-[300px] px-3 py-3">
                        <a
                          href={fileUrl(file.id)}
                          target="_blank"
                          rel="noreferrer"
                          className="block truncate font-medium hover:text-primary"
                          title={file.name}
                        >
                          {file.name}
                        </a>
                        <span className="text-xs text-muted-foreground">{file.mime || "未知类型"}</span>
                      </td>
                      <td className="px-3 py-3">
                        <Badge tone="outline">{SCOPE_LABELS[file.scope] ?? file.scope}</Badge>
                      </td>
                      <td className="px-3 py-3">
                        <span className="font-medium">{file.owner_name ?? "—"}</span>
                        {file.owner_username && <div className="text-xs text-muted-foreground">{file.owner_username}</div>}
                      </td>
                      <td className="px-3 py-3 font-medium tabular-nums">{formatBytes(file.size)}</td>
                      <td className="px-3 py-3 text-muted-foreground">{formatTime(file.created_at)}</td>
                      <td className="px-3 py-3">
                        {target ? (
                          <Link to={target.to} className="text-xs text-primary hover:underline">
                            {target.label}
                          </Link>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <Button
                          variant="destructive-ghost"
                          size="icon"
                          onClick={() => void deleteFiles([file.id], file.size)}
                          disabled={deleting}
                          aria-label={`删除 ${file.name}`}
                          title="删除文件"
                        >
                          <Trash2 />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={<HardDrive />}
            title={fileScope || fileClass || fileOwner || fileQuery ? "没有匹配的文件" : "还没有附件"}
            description={
              fileScope || fileClass || fileOwner || fileQuery
                ? "可以调整类型、班级、学员或文件名筛选条件"
                : "学员上传日志、作品附件或管理员上传任务附件后，这里会显示文件明细"
            }
            action={
              fileScope || fileClass || fileOwner || fileQuery ? (
                <Button variant="outline" onClick={clearFileFilters}>
                  清除筛选
                </Button>
              ) : undefined
            }
          />
        )}

        {hasMore && (
          <div className="flex justify-center border-t px-5 py-3">
            <Button variant="outline" onClick={() => void setFilePageCount(filePageCount + 1)} loading={filesValidating}>
              加载更多
            </Button>
          </div>
        )}
        <p className="border-t px-5 py-3 text-xs text-muted-foreground">
          文件列表按游标分页，只查询当前页的元数据；删除时会同步清理对象存储，并写入一条审计日志。下载或预览不会在列表中自动加载，避免额外读取存储。
        </p>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title="按学员统计"
          description={`共 ${data.students.length} 名学员，按占用从高到低排列。`}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <input type="checkbox" className="size-4 accent-primary" checked={onlyUsed} onChange={(e) => setOnlyUsed(e.target.checked)} />
                仅显示有占用
              </label>
            </div>
          }
        />
        <div className="flex flex-col gap-3 border-b px-5 py-3 sm:flex-row">
          <div className="relative sm:w-72">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索姓名或用户名"
              className="pl-9"
              aria-label="搜索学员"
            />
          </div>
          {classes.length > 0 && (
            <Select value={classFilter} onChange={(e) => setClassFilter(e.target.value)} className="sm:w-48" aria-label="按班级筛选">
              <option value="">全部班级</option>
              {classes.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          )}
          <span className="self-center text-sm text-muted-foreground">
            显示 {students.length} / {data.students.length} 名
          </span>
        </div>

        {students.length ? (
          <div className="max-h-[640px] overflow-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="sticky top-0 z-10 border-b bg-muted text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-5 py-2.5 font-medium">学员</th>
                  <th className="px-3 py-2.5 font-medium">班级</th>
                  <th className="px-3 py-2.5 font-medium">附件</th>
                  <th className="px-3 py-2.5 font-medium">占用</th>
                  <th className="px-3 py-2.5 font-medium">学员配额</th>
                  <th className="px-5 py-2.5 font-medium">最近上传</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {students.map((s) => {
                  const percent = storage.student_quota_bytes > 0 ? (s.total_bytes / storage.student_quota_bytes) * 100 : 0;
                  return (
                    <tr key={s.id} className={cn("hover:bg-muted/40", !s.active && "opacity-55")}>
                      <td className="px-5 py-3">
                        <Link to={`/admin/students/${s.id}`} className="flex flex-col hover:text-primary">
                          <span className="flex items-center gap-1.5 font-medium">
                            {s.name}
                            {!s.active && <Badge>已停用</Badge>}
                          </span>
                          <span className="text-xs text-muted-foreground">{s.username}</span>
                        </Link>
                      </td>
                      <td className="px-3 py-3 text-muted-foreground">{s.class_name ?? "未分班"}</td>
                      <td className="px-3 py-3 tabular-nums text-muted-foreground">
                        {s.file_count ? (
                          <button
                            type="button"
                            className="hover:text-primary hover:underline"
                            onClick={() => focusOwnerFiles(s)}
                            title="查看该学员的附件"
                          >
                            {s.file_count}
                          </button>
                        ) : (
                          0
                        )}
                        {s.avatar_bytes > 0 && <span className="ml-1 text-xs">+头像</span>}
                      </td>
                      <td className="px-3 py-3">
                        <div className="font-medium tabular-nums">{formatBytes(s.total_bytes)}</div>
                        {s.avatar_bytes > 0 && <div className="text-xs text-muted-foreground">头像 {formatBytes(s.avatar_bytes)}</div>}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <ProgressBar value={percent} tone={quotaTone(percent)} className="w-24" label={`${s.name} 配额使用率`} />
                          <span
                            className={cn(
                              "w-12 text-right text-xs tabular-nums",
                              percent >= 100 ? "font-medium text-destructive" : "text-muted-foreground",
                            )}
                          >
                            {percent.toFixed(0)}%
                          </span>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">上限 {formatBytes(storage.student_quota_bytes)}</div>
                      </td>
                      <td className="px-5 py-3 text-muted-foreground">{formatTime(s.last_upload_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={<HardDrive />}
            title={data.students.length ? "没有匹配的学员" : "还没有学员"}
            description={data.students.length ? "可以调整搜索或筛选条件" : "添加学员并上传附件后，这里会显示每个人的占用情况"}
          />
        )}
      </Card>

      <p className="text-xs text-muted-foreground">
        统计时间：{new Date(data.generated_at).toLocaleString("zh-CN")}
      </p>
    </div>
  );
}
