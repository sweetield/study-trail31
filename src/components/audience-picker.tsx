import { useState } from "react";
import { Search, X } from "lucide-react";
import type { AudienceMode, AudienceStudent, ClassItem } from "@/lib/types";
import { Button, Field, Input, SegmentedTabs } from "@/components/ui";

export interface AudienceValue {
  classIds: number[];
  /** 排除学员 ID。include 模式下，未勾选的学员会出现在这里，保存后即“只发给勾选学员”。 */
  excluded: number[];
  mode: AudienceMode;
}

const MODE_OPTIONS = [
  { key: "exclude", label: "排除勾选" },
  { key: "include", label: "只发给勾选" },
] as const satisfies readonly { key: AudienceMode; label: string }[];

/**
 * 发布范围选择器：班级范围 + 学员名单。
 * 名单支持按姓名 / 用户名 / 班级搜索，以及全选、反选、清空。
 * 两种模式共用同一份 excluded 数据，切换模式只改变勾选的语义，不会改变实际可见范围。
 */
export function AudiencePicker({
  noun,
  classLabel = "发布班级",
  classes,
  students,
  value,
  onChange,
}: {
  /** 用于文案，例如“任务”“资料” */
  noun: string;
  classLabel?: string;
  classes: ClassItem[];
  students: AudienceStudent[];
  value: AudienceValue;
  onChange: (next: AudienceValue) => void;
}) {
  const [query, setQuery] = useState("");
  const { classIds, excluded, mode } = value;

  const eligible = students.filter((s) => !classIds.length || (s.class_id != null && classIds.includes(s.class_id)));
  const keyword = query.trim().toLowerCase();
  const shown = keyword
    ? eligible.filter((s) =>
        [s.name, s.username, s.class_name ?? ""].some((field) => field.toLowerCase().includes(keyword)),
      )
    : eligible;

  const excludedSet = new Set(excluded);
  const eligibleIds = new Set(eligible.map((s) => s.id));
  const excludedInScope = excluded.filter((id) => eligibleIds.has(id));
  const recipients = eligible.length - excludedInScope.length;
  const shownChecked = shown.filter((s) => (mode === "include" ? !excludedSet.has(s.id) : excludedSet.has(s.id))).length;

  function updateExcluded(next: number[]) {
    onChange({ ...value, excluded: [...new Set(next)] });
  }

  function toggleStudent(userId: number) {
    updateExcluded(excludedSet.has(userId) ? excluded.filter((id) => id !== userId) : [...excluded, userId]);
  }

  /** 勾选 / 取消勾选当前搜索结果 */
  function setShownChecked(checked: boolean) {
    const ids = new Set(shown.map((s) => s.id));
    if (mode === "include") {
      updateExcluded(checked ? excluded.filter((id) => !ids.has(id)) : [...excluded, ...ids]);
    } else {
      updateExcluded(checked ? [...excluded, ...ids] : excluded.filter((id) => !ids.has(id)));
    }
  }

  /** 反选当前搜索结果：已勾选变未勾选，未勾选变已勾选 */
  function invertShown() {
    const ids = new Set(shown.map((s) => s.id));
    const next = new Set(excluded);
    for (const id of ids) {
      if (next.has(id)) next.delete(id);
      else next.add(id);
    }
    updateExcluded([...next]);
  }

  function toggleClass(classId: number) {
    const next = classIds.includes(classId) ? classIds.filter((id) => id !== classId) : [...classIds, classId];
    const allowed = new Set(students.filter((s) => !next.length || (s.class_id != null && next.includes(s.class_id))).map((s) => s.id));
    // 排除模式：移除不再属于范围的排除学员
    // 仅勾选模式：新加入范围的学员默认不勾选，避免误发
    const kept = excluded.filter((id) => allowed.has(id));
    const nextExcluded =
      mode === "include"
        ? [...new Set([...kept, ...students.filter((s) => allowed.has(s.id) && !eligibleIds.has(s.id)).map((s) => s.id)])]
        : kept;
    onChange({ classIds: next, excluded: nextExcluded, mode });
  }

  function clearClasses() {
    onChange({ classIds: [], excluded: [], mode });
  }

  return (
    <>
      <Field
        label={classLabel}
        hint={
          classIds.length
            ? `仅选中的 ${classIds.length} 个班级可见${mode === "include" ? "，可在下方勾选具体学员" : "，可继续排除个别学员"}`
            : "未选择班级时面向全部学员；勾选班级可缩小范围"
        }
      >
        <div className="flex flex-col gap-1.5">
          {classes.length ? (
            classes.map((c) => (
              <label key={c.id} className="flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm hover:bg-muted/50">
                <input type="checkbox" checked={classIds.includes(c.id)} onChange={() => toggleClass(c.id)} className="size-4 accent-primary" />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{c.student_count} 人</span>
              </label>
            ))
          ) : (
            <p className="rounded-lg border border-dashed px-3 py-2.5 text-sm text-muted-foreground">
              还没有班级，{noun}将面向全部学员。可先在「学员管理 → 班级管理」中创建班级。
            </p>
          )}
          {classIds.length > 0 && (
            <button type="button" onClick={clearClasses} className="self-start text-xs text-primary hover:underline">
              清除班级选择（改为全部学员）
            </button>
          )}
        </div>
      </Field>

      <Field
        label={
          mode === "include"
            ? `接收学员（${recipients} 人）`
            : `排除学员${excludedInScope.length ? `（已排除 ${excludedInScope.length} 人）` : ""}`
        }
        hint={
          mode === "include"
            ? recipients
              ? `仅勾选的 ${recipients} 名学员会收到${noun}通知并可查看，未勾选的学员不可见`
              : `尚未勾选任何学员，保存后不会有学员收到${noun}`
            : `被排除的学员不会收到${noun}通知，也无法查看`
        }
      >
        <div className="flex flex-col gap-2">
          <SegmentedTabs options={MODE_OPTIONS} value={mode} onChange={(next) => onChange({ ...value, mode: next })} label="名单勾选方式" />

          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索姓名、用户名或班级"
              className="pr-9 pl-9"
              aria-label={`搜索${mode === "include" ? "接收" : "排除"}学员`}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="清除搜索"
              >
                <X className="size-4" />
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => setShownChecked(true)} disabled={!shown.length} title="勾选当前搜索结果中的全部学员">
              全选
            </Button>
            <Button size="sm" variant="ghost" onClick={invertShown} disabled={!shown.length} title="对当前搜索结果反选">
              反选
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShownChecked(false)} disabled={!shown.length} title="取消勾选当前搜索结果中的全部学员">
              清空
            </Button>
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {shown.length} 人 · 已勾选 {shownChecked} 人
            </span>
          </div>

          <div className="max-h-52 overflow-y-auto rounded-lg border">
            {shown.length ? (
              <ul className="divide-y">
                {shown.map((s) => {
                  const checked = mode === "include" ? !excludedSet.has(s.id) : excludedSet.has(s.id);
                  return (
                    <li key={s.id}>
                      <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted/50">
                        <input type="checkbox" checked={checked} onChange={() => toggleStudent(s.id)} className="size-4 accent-primary" />
                        <span className="min-w-0 flex-1 truncate">{s.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{s.class_name ?? s.username}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                {eligible.length ? "没有匹配的学员" : classIds.length ? "所选班级暂无学员" : "暂无学员"}
              </p>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            {mode === "include"
              ? `共 ${eligible.length} 名候选学员，只会发给勾选的 ${recipients} 人`
              : `共 ${eligible.length} 名候选学员，勾选表示排除，已排除 ${excludedInScope.length} 人`}
          </p>
        </div>
      </Field>
    </>
  );
}
