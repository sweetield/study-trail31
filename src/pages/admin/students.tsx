import { useDeferredValue, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import useSWR, { mutate } from "swr";
import { ChevronLeft, ChevronRight, FileUp, FolderInput, GraduationCap, KeyRound, Pencil, Plus, Power, Search, Trash2, UserPlus, Users, X } from "lucide-react";
import { api } from "@/lib/api";
import { useMe } from "@/lib/auth";
import type { AdminStudent, ClassItem } from "@/lib/types";
import { cn, formatMinutes, formatTime } from "@/lib/utils";
import { useToast } from "@/components/toast";
import { Avatar } from "@/components/avatar";
import { AccountInfoDialog, type GeneratedAccountInfo } from "@/components/account-info-dialog";
import { MultiSelectFilter } from "@/components/multi-select-filter";
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, PageHeader, PageLoader, ProgressBar, Select, Textarea } from "@/components/ui";

const PAGE_SIZE = 50;
const refreshAdmin = () => mutate((k) => typeof k === "string" && k.startsWith("/api/admin/"));

interface StudentsPage {
  students: AdminStudent[];
  total: number;
  page: number;
  pageSize: number;
}

interface ResetPasswordResult {
  count: number;
  accounts: GeneratedAccountInfo[];
  zipName: string;
  zip: string;
}

export default function AdminStudents() {
  const { user } = useMe();
  const canManage = !!user?.is_super_admin;
  const [query, setQuery] = useState("");
  const [classFilter, setClassFilter] = useState<number[]>([]);
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<"add" | "batch" | "classes" | null>(null);
  const [editing, setEditing] = useState<AdminStudent | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [batchClassOpen, setBatchClassOpen] = useState(false);
  const [batchResetOpen, setBatchResetOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const anchorRef = useRef<number | null>(null);
  const toast = useToast();
  const q = useDeferredValue(query.trim().toLowerCase());

  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (q) params.set("q", q);
  // 班级筛选支持多选：0 表示未分班，与真实班级 ID 一起提交
  const classIds = classFilter.filter((id) => id > 0);
  if (classIds.length) params.set("class_ids", classIds.join(","));
  if (classFilter.includes(0)) params.set("unassigned", "1");
  const classKey = classFilter.join(",");
  const url = `/api/admin/students?${params.toString()}`;
  const { data, mutate: reload } = useSWR<StudentsPage>(url, { keepPreviousData: true });
  const { data: classData } = useSWR<{ classes: ClassItem[] }>("/api/admin/classes");

  useEffect(() => {
    setPage(1);
  }, [q, classKey]);

  useEffect(() => {
    setSelected(new Set());
    anchorRef.current = null;
  }, [url]);

  if (!data || !classData) return <PageLoader />;
  const classes = classData.classes;
  const list = data.students;
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const allChecked = list.length > 0 && list.every((s) => selected.has(s.id));

  function toggleSelect(id: number, index: number, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (event.shiftKey && anchorRef.current != null) {
        const anchorIndex = list.findIndex((s) => s.id === anchorRef.current);
        if (anchorIndex >= 0) {
          const start = Math.min(anchorIndex, index);
          const end = Math.max(anchorIndex, index);
          for (let i = start; i <= end; i++) next.add(list[i].id);
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    anchorRef.current = id;
  }

  function toggleAll() {
    setSelected(allChecked ? new Set() : new Set(list.map((s) => s.id)));
    anchorRef.current = null;
  }

  async function batchUpdate(payload: { active?: boolean; class_id?: number | null }, message: string) {
    setBusy(true);
    try {
      await api.post("/api/admin/students/batch-update", { ids: [...selected], ...payload });
      await refreshAdmin();
      await reload();
      setSelected(new Set());
      setBatchClassOpen(false);
      toast(message);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function batchDelete() {
    if (!confirm(`确定删除选中的 ${selected.size} 名学员吗？其所有学习进度、日志、附件与头像都会被永久删除。若只是暂时不用，建议改用停用账号。`)) return;
    setBusy(true);
    try {
      await api.post("/api/admin/students/batch-delete", { ids: [...selected] });
      await refreshAdmin();
      await reload();
      setSelected(new Set());
      toast("已删除所选学员");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function afterBatchReset() {
    setSelected(new Set());
    await refreshAdmin();
    await reload();
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="学员管理"
        description={`共 ${data.total} 名学员 · ${classes.length} 个班级`}
        action={
          canManage && (
            <>
              <Button variant="outline" onClick={() => setDialog("classes")}>
                <Users /> 班级管理
              </Button>
              <Button variant="outline" onClick={() => setDialog("batch")}>
                <FileUp /> 批量导入
              </Button>
              <Button onClick={() => setDialog("add")}>
                <UserPlus /> 添加学员
              </Button>
            </>
          )
        }
      />

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索姓名或用户名" className="pl-9" aria-label="搜索学员" />
        </div>
        <MultiSelectFilter
          icon={<GraduationCap />}
          label="班级筛选"
          options={[{ id: 0, title: "未分班" }, ...classes.map((c) => ({ id: c.id, title: c.name }))]}
          value={classFilter}
          onChange={setClassFilter}
          searchPlaceholder="搜索班级名称"
          emptyText="暂无班级"
          align="left"
        />
      </div>

      {canManage && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-primary-soft/40 px-4 py-3">
          <span className="mr-1 text-sm font-medium">已选 {selected.size} 名学员</span>
          <Button size="sm" variant="outline" onClick={() => setBatchClassOpen(true)} disabled={busy}>
            <FolderInput /> 调整班级
          </Button>
          <Button size="sm" variant="outline" onClick={() => setBatchResetOpen(true)} disabled={busy}>
            <KeyRound /> 重置密码
          </Button>
          <Button size="sm" variant="outline" onClick={() => batchUpdate({ active: true }, "已启用所选账号")} disabled={busy}>
            <Power /> 启用账号
          </Button>
          <Button size="sm" variant="outline" onClick={() => batchUpdate({ active: false }, "已停用所选账号")} disabled={busy}>
            <Power /> 停用账号
          </Button>
          <Button size="sm" variant="destructive-ghost" onClick={batchDelete} disabled={busy}>
            <Trash2 /> 批量删除
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} disabled={busy} className="ml-auto">
            <X /> 取消选择
          </Button>
        </div>
      )}

      <Card className="overflow-hidden">
        {list.length ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px] text-sm">
                <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    {canManage && (
                      <th className="w-10 px-4 py-2.5">
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked={allChecked}
                          onChange={toggleAll}
                          aria-label="选择本页全部学员"
                        />
                      </th>
                    )}
                    <th className={cn("py-2.5 font-medium", canManage ? "px-2" : "px-5")}>学员</th>
                    <th className="px-3 py-2.5 font-medium">班级</th>
                    <th className="px-3 py-2.5 font-medium">任务完成</th>
                    <th className="px-3 py-2.5 font-medium">学习时长</th>
                    <th className="px-3 py-2.5 font-medium">最近活跃</th>
                    <th className="px-5 py-2.5 text-right font-medium">
                      <span className="sr-only">操作</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {list.map((s, index) => {
                    const rate = s.assigned ? Math.round((s.completed / s.assigned) * 100) : 0;
                    return (
                      <tr key={s.id} className={cn("hover:bg-muted/40", !s.active && "opacity-55", selected.has(s.id) && "bg-primary-soft/30")}>
                        {canManage && (
                          <td className="px-4 py-3">
                            <input
                              type="checkbox"
                              className="size-4 accent-primary"
                              checked={selected.has(s.id)}
                              onChange={(e) => toggleSelect(s.id, index, e.nativeEvent as MouseEvent)}
                              aria-label={`选择 ${s.name}`}
                            />
                          </td>
                        )}
                        <td className={cn("py-3", canManage ? "px-2" : "px-5")}>
                          <Link to={`/admin/students/${s.id}`} className="flex items-center gap-3">
                            <Avatar name={s.name} avatarId={s.avatar_id} className="size-8 text-xs" />
                            <span>
                              <span className="flex items-center gap-1.5 font-medium hover:text-primary">
                                {s.name}
                                {!s.active && <Badge>已停用</Badge>}
                                {!!s.must_change_password && s.active && <Badge tone="outline">未改初始密码</Badge>}
                              </span>
                              <span className="block text-xs text-muted-foreground">{s.username}</span>
                            </span>
                          </Link>
                        </td>
                        <td className="px-3 py-3 text-muted-foreground">{s.class_name ?? "未分班"}</td>
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-2">
                            <ProgressBar value={rate} className="w-20" />
                            <span className="text-xs tabular-nums text-muted-foreground">
                              {s.completed}/{s.assigned}
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-3 tabular-nums text-muted-foreground">{formatMinutes(s.minutes)}</td>
                        <td className="px-3 py-3 text-muted-foreground">{formatTime(s.last_active_at ?? s.last_login_at)}</td>
                        <td className="px-5 py-3 text-right">
                          <Button variant="ghost" size="icon" onClick={() => setEditing(s)} aria-label={`编辑 ${s.name}`}>
                            <Pencil />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3 text-sm">
              <span className="text-muted-foreground">
                第 {data.page} / {totalPages} 页 · 共 {data.total} 名
              </span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  <ChevronLeft /> 上一页
                </Button>
                <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
                  下一页 <ChevronRight />
                </Button>
              </div>
            </div>
          </>
        ) : (
          <EmptyState
            icon={<Users />}
            title={data.total ? "没有匹配的学员" : "还没有学员"}
            description={data.total ? undefined : canManage ? "可以逐个添加，也可以从 Excel 复制名单批量导入" : "管理员还没有添加学员"}
            action={!data.total && canManage && <Button onClick={() => setDialog("batch")}>批量导入学员</Button>}
          />
        )}
      </Card>

      <AddStudentDialog open={dialog === "add"} onClose={() => setDialog(null)} classes={classes} />
      <BatchImportDialog open={dialog === "batch"} onClose={() => setDialog(null)} classes={classes} />
      <ClassesDialog open={dialog === "classes"} onClose={() => setDialog(null)} classes={classes} />
      <EditStudentDialog student={editing} onClose={() => setEditing(null)} classes={classes} canManage={canManage} />
      <BatchClassDialog
        open={batchClassOpen}
        onClose={() => setBatchClassOpen(false)}
        classes={classes}
        count={selected.size}
        loading={busy}
        onApply={(classId) => batchUpdate({ class_id: classId }, "已调整所选学员的班级")}
      />
      <ResetPasswordDialog
        open={batchResetOpen}
        onClose={() => setBatchResetOpen(false)}
        ids={[...selected]}
        onReset={afterBatchReset}
      />
    </div>
  );
}

function ErrorText({ error }: { error: string }) {
  if (!error) return null;
  return (
    <p className="rounded-lg bg-destructive-soft px-3 py-2 text-sm text-destructive" role="alert">
      {error}
    </p>
  );
}

function ClassSelect({ classes, defaultValue, id = "class_id" }: { classes: ClassItem[]; defaultValue?: number | null; id?: string }) {
  return (
    <Select id={id} name="class_id" defaultValue={defaultValue ?? ""}>
      <option value="">未分班</option>
      {classes.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </Select>
  );
}

/** 班级选择器：在添加 / 导入学员时可直接新建班级并自动选中 */
function ClassSelectWithCreate({
  classes,
  value,
  onChange,
  id = "class_id",
}: {
  classes: ClassItem[];
  value: string;
  onChange: (value: string) => void;
  id?: string;
}) {
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function create() {
    const next = name.trim();
    if (!next) {
      setError("请输入班级名称");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await api.post<{ class: { id: number; name: string } }>("/api/admin/classes", { name: next });
      await mutate("/api/admin/classes");
      onChange(String(res.class.id));
      setName("");
      setCreating(false);
      toast(`班级「${res.class.name}」已创建`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="min-w-0 flex-1">
          <option value="">未分班</option>
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setCreating((v) => !v);
            setError("");
          }}
          aria-expanded={creating}
        >
          <Plus /> 新建班级
        </Button>
      </div>
      {creating && (
        <div className="flex gap-2 rounded-lg border bg-muted/40 p-2">
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void create();
              }
            }}
            placeholder="例如：前端 2026 春季班"
            maxLength={40}
            autoFocus
            aria-label="新班级名称"
          />
          <Button type="button" onClick={create} loading={loading}>
            创建
          </Button>
        </div>
      )}
      <ErrorText error={error} />
    </div>
  );
}

function useFormAction(onDone: () => void) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function run(fn: () => Promise<void>) {
    setLoading(true);
    setError("");
    try {
      await fn();
      await refreshAdmin();
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }
  return { loading, error, run };
}

function AddStudentDialog({ open, onClose, classes }: { open: boolean; onClose: () => void; classes: ClassItem[] }) {
  const toast = useToast();
  const [account, setAccount] = useState<GeneratedAccountInfo | null>(null);
  const [siteUrl, setSiteUrl] = useState(() => window.location.origin);
  const [classId, setClassId] = useState("");
  const { loading, error, run } = useFormAction(() => {});

  useEffect(() => {
    if (open) {
      setSiteUrl(window.location.origin);
      setClassId("");
    } else setAccount(null);
  }, [open]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    run(async () => {
      const res = await api.post<{ account: GeneratedAccountInfo }>("/api/admin/students", {
        username: f.get("username"),
        name: f.get("name"),
        class_id: classId ? Number(classId) : null,
        site_url: siteUrl.trim(),
      });
      setAccount(res.account);
      toast("学员已添加，请保存账号信息");
    });
  }

  function closeAccount() {
    setAccount(null);
    onClose();
  }

  return (
    <>
      <Dialog
        open={open && !account}
        onClose={() => {
          if (!account) onClose();
        }}
        title="添加学员"
        description="系统会自动生成 22 位随机密码，完成后可复制或下载账号信息"
      >
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="姓名" htmlFor="name">
              <Input id="name" name="name" required maxLength={32} />
            </Field>
            <Field label="用户名" htmlFor="username">
              <Input id="username" name="username" required pattern="[a-zA-Z0-9_.\-]+" maxLength={32} placeholder="学号或拼音" />
            </Field>
          </div>
          <Field label="网址" htmlFor="add-site" hint="写入账号信息文档；留空则使用当前访问地址">
            <Input
              id="add-site"
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)}
              placeholder="https://example.com"
              inputMode="url"
              autoComplete="url"
            />
          </Field>
          <Field label="班级" htmlFor="class_id" hint="没有合适的班级时可直接新建，创建后会自动选中">
            <ClassSelectWithCreate classes={classes} value={classId} onChange={setClassId} />
          </Field>
          <ErrorText error={error} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" loading={loading}>
              添加
            </Button>
          </div>
        </form>
      </Dialog>
      <AccountInfoDialog
        open={open && !!account}
        onClose={closeAccount}
        accounts={account ? [account] : []}
      />
    </>
  );
}

interface BatchImportResult {
  created: number;
  skipped: number;
  accounts: GeneratedAccountInfo[];
  zipName: string;
  zip: string;
}

function BatchImportDialog({ open, onClose, classes }: { open: boolean; onClose: () => void; classes: ClassItem[] }) {
  const toast = useToast();
  const [result, setResult] = useState<BatchImportResult | null>(null);
  const [siteUrl, setSiteUrl] = useState(() => window.location.origin);
  const [classId, setClassId] = useState("");
  const { loading, error, run } = useFormAction(() => {});

  useEffect(() => {
    if (open) {
      setSiteUrl(window.location.origin);
      setClassId("");
    } else setResult(null);
  }, [open]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    run(async () => {
      const res = await api.post<BatchImportResult>("/api/admin/students/batch", {
        lines: f.get("lines"),
        class_id: classId ? Number(classId) : null,
        site_url: siteUrl.trim(),
      });
      setResult(res);
      toast(`成功导入 ${res.created} 人${res.skipped ? `，跳过 ${res.skipped} 个重复或已存在的用户名` : ""}，请保存账号信息`);
    });
  }

  function closeResult() {
    setResult(null);
    onClose();
  }

  return (
    <>
      <Dialog
        open={open && !result}
        onClose={() => {
          if (!result) onClose();
        }}
        title="批量导入学员"
        description="每行一名学员：用户名 + 姓名。导入后自动为每人生成 22 位随机密码，完成后可复制或下载账号信息。"
      >
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <Field label="学员名单" htmlFor="lines" hint="用户名与姓名之间用空格、逗号或 Tab 分隔，单次最多 500 人">
            <Textarea id="lines" name="lines" required rows={8} className="font-mono text-xs" placeholder={"2024001 张三\n2024002 李四\nwangwu,王五"} />
          </Field>
          <Field label="网址" htmlFor="batch-site" hint="写入每份账号信息文档；留空则使用当前访问地址">
            <Input
              id="batch-site"
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)}
              placeholder="https://example.com"
              inputMode="url"
              autoComplete="url"
            />
          </Field>
          <Field label="导入到班级" htmlFor="batch-class" hint="没有合适的班级时可直接新建；学员无需修改初始密码，可直接使用账号信息登录">
            <ClassSelectWithCreate classes={classes} value={classId} onChange={setClassId} id="batch-class" />
          </Field>
          <ErrorText error={error} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" loading={loading}>
              开始导入
            </Button>
          </div>
        </form>
      </Dialog>
      <AccountInfoDialog
        open={open && !!result}
        onClose={closeResult}
        accounts={result?.accounts ?? []}
        zipBase64={result?.zip}
        zipName={result?.zipName}
        created={result?.created}
        skipped={result?.skipped}
      />
    </>
  );
}

function EditStudentDialog({
  student,
  onClose,
  classes,
  canManage,
}: {
  student: AdminStudent | null;
  onClose: () => void;
  classes: ClassItem[];
  canManage: boolean;
}) {
  const toast = useToast();
  const { loading, error, run } = useFormAction(onClose);
  const [resetOpen, setResetOpen] = useState(false);

  useEffect(() => {
    if (!student) setResetOpen(false);
  }, [student]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    run(async () => {
      await api.patch(`/api/admin/students/${student!.id}`, {
        name: f.get("name"),
        ...(canManage
          ? {
              class_id: f.get("class_id") ? Number(f.get("class_id")) : null,
              active: f.get("active") === "on",
            }
          : {}),
      });
      toast("已保存");
    });
  }

  function remove() {
    if (!confirm(`确定删除学员「${student!.name}」吗？其所有进度与日志将被永久删除。若只是暂时不用，建议停用账号。`)) return;
    run(async () => {
      await api.del(`/api/admin/students/${student!.id}`);
      toast("学员已删除");
    });
  }

  return (
    <>
      <Dialog
        open={!!student}
        onClose={onClose}
        title={`编辑学员：${student?.name ?? ""}`}
        description={student?.username}
      >
        {student && (
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div className={cn("grid gap-3", canManage && "grid-cols-2")}>
              <Field label="姓名" htmlFor="edit-name">
                <Input id="edit-name" name="name" required maxLength={32} defaultValue={student.name} />
              </Field>
              {canManage && (
                <Field label="班级" htmlFor="edit-class">
                  <ClassSelect classes={classes} defaultValue={student.class_id} id="edit-class" />
                </Field>
              )}
            </div>
            {canManage && (
              <div className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
                <span className="min-w-0">
                  <span className="block font-medium">重置密码</span>
                  <span className="block text-xs text-muted-foreground">按创建账号的规则生成 22 位随机密码，学员无需修改初始密码</span>
                </span>
                <Button variant="outline" onClick={() => setResetOpen(true)}>
                  <KeyRound /> 重置密码
                </Button>
              </div>
            )}
            {canManage && (
              <label className="flex items-center gap-3 rounded-lg border p-3 text-sm">
                <input type="checkbox" name="active" defaultChecked={!!student.active} className="size-4 accent-primary" />
                <span>
                  <span className="block font-medium">账号启用</span>
                  <span className="block text-xs text-muted-foreground">停用后无法登录，数据保留</span>
                </span>
              </label>
            )}
            <ErrorText error={error} />
            <div className="flex items-center justify-between gap-2">
              {canManage ? (
                <Button variant="destructive-ghost" onClick={remove}>
                  <Trash2 /> 删除
                </Button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <Button variant="ghost" onClick={onClose}>
                  取消
                </Button>
                <Button type="submit" loading={loading}>
                  保存
                </Button>
              </div>
            </div>
          </form>
        )}
      </Dialog>
      <ResetPasswordDialog
        open={resetOpen && !!student}
        onClose={() => setResetOpen(false)}
        ids={student ? [student.id] : []}
        onReset={async () => {
          await refreshAdmin();
        }}
      />
    </>
  );
}

function BatchClassDialog({
  open,
  onClose,
  classes,
  count,
  loading,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  classes: ClassItem[];
  count: number;
  loading: boolean;
  onApply: (classId: number | null) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <Dialog open={open} onClose={onClose} title="调整学员班级" description={`将选中的 ${count} 名学员调整到指定班级`}>
      <div className="flex flex-col gap-4">
        <Field label="目标班级" htmlFor="batch-target-class">
          <Select id="batch-target-class" value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">未分班</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            取消
          </Button>
          <Button onClick={() => onApply(value ? Number(value) : null)} loading={loading}>
            确认调整
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function ResetPasswordDialog({
  open,
  onClose,
  ids,
  onReset,
}: {
  open: boolean;
  onClose: () => void;
  ids: number[];
  onReset: () => Promise<void>;
}) {
  const toast = useToast();
  const [result, setResult] = useState<ResetPasswordResult | null>(null);
  const [siteUrl, setSiteUrl] = useState(() => window.location.origin);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const single = ids.length === 1;

  useEffect(() => {
    if (open) setSiteUrl(window.location.origin);
    else {
      setResult(null);
      setError("");
    }
  }, [open]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ids.length) return;
    setLoading(true);
    setError("");
    try {
      const res = await api.post<ResetPasswordResult>("/api/admin/students/batch-reset-password", {
        ids,
        site_url: siteUrl.trim(),
      });
      setResult(res);
      toast(single ? "已生成新的随机密码" : `已为 ${res.count} 名学员生成新的随机密码`);
      await onReset().catch(() => {});
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function close() {
    setResult(null);
    setError("");
    onClose();
  }

  return (
    <>
      <Dialog
        open={open && !result}
        onClose={() => {
          // 密码重置成功后表单弹窗会被关闭，此时不要把账号信息弹窗一起关掉
          if (!result) onClose();
        }}
        title={single ? "重置密码" : "批量重置密码"}
        description={single ? "将生成新的随机密码，原登录状态会立即失效" : `将为选中的 ${ids.length} 名学员生成新的随机密码，原登录状态会立即失效`}
      >
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <Field label="登录网址" htmlFor="reset-site" hint="写入账号信息文档；留空则使用当前访问地址">
            <Input
              id="reset-site"
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)}
              placeholder="https://example.com"
              inputMode="url"
              autoComplete="url"
            />
          </Field>
          <div className="flex items-start gap-2 rounded-lg bg-primary-soft/50 px-3 py-2.5 text-sm text-foreground">
            <KeyRound className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
            <span>
              {single
                ? "与创建账号一致，系统会生成 22 位复杂随机密码，学员可直接登录，无需自行修改初始密码。"
                : "与创建账号一致，系统会为每位学员生成 22 位复杂随机密码，学员可直接登录，无需自行修改初始密码。"}
            </span>
          </div>
          <ErrorText error={error} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={loading}>
              取消
            </Button>
            <Button type="submit" loading={loading}>
              确认重置
            </Button>
          </div>
        </form>
      </Dialog>
      <AccountInfoDialog
        open={open && !!result}
        onClose={close}
        accounts={result?.accounts ?? []}
        zipBase64={result?.zip}
        zipName={result?.zipName}
        title="新的账号信息"
        description={
          single
            ? "密码已重置。请复制或下载保存，关闭后将无法再次查看密码。"
            : `已为 ${result?.count ?? 0} 名学员重置密码。请复制或下载保存，关闭后将无法再次查看密码。`
        }
        notice="密码已按创建账号的规则随机生成并直接写入账号，学员无需修改初始密码。"
      />
    </>
  );
}

function ClassesDialog({ open, onClose, classes }: { open: boolean; onClose: () => void; classes: ClassItem[] }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  async function add(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await api.post("/api/admin/classes", { name });
      setName("");
      await refreshAdmin();
      toast("班级已创建");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function rename(c: ClassItem) {
    const next = prompt("新的班级名称", c.name)?.trim();
    if (!next || next === c.name) return;
    await api.patch(`/api/admin/classes/${c.id}`, { name: next }).catch((e) => toast((e as Error).message, "error"));
    await refreshAdmin();
  }

  async function remove(c: ClassItem) {
    if (!confirm(`删除班级「${c.name}」？该班学员将变为未分班，指定给该班的任务将改为面向全部学员。`)) return;
    await api.del(`/api/admin/classes/${c.id}`);
    await refreshAdmin();
    toast("班级已删除");
  }

  return (
    <Dialog open={open} onClose={onClose} title="班级管理" description="按班级发布任务、查看进度矩阵">
      <div className="flex flex-col gap-4">
        <form onSubmit={add} className="flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：前端 2026 春季班" maxLength={40} required aria-label="班级名称" />
          <Button type="submit">
            <Plus /> 创建
          </Button>
        </form>
        <ErrorText error={error} />
        {classes.length ? (
          <Card>
            <CardHeader title={`已有 ${classes.length} 个班级`} className="py-3" />
            <ul className="divide-y">
              {classes.map((c) => (
                <li key={c.id} className="flex items-center gap-3 px-5 py-2.5">
                  <span className="flex-1 text-sm font-medium">{c.name}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{c.student_count} 人</span>
                  <Button variant="ghost" size="icon" onClick={() => rename(c)} aria-label={`重命名 ${c.name}`}>
                    <Pencil />
                  </Button>
                  <Button variant="destructive-ghost" size="icon" onClick={() => remove(c)} aria-label={`删除 ${c.name}`}>
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        ) : (
          <EmptyState title="还没有班级" description="不分班也可以使用，所有任务默认面向全部学员" />
        )}
      </div>
    </Dialog>
  );
}