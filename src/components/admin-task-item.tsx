import { Link } from "react-router";
import { CalendarClock, ChevronRight, Pin, Users } from "lucide-react";
import type { AdminTask } from "@/lib/types";
import { cn, dueInfo, splitTags } from "@/lib/utils";
import { PriorityBadge } from "./priority-badge";
import { StackedBar } from "./stacked-bar";
import { Badge, TechTag } from "./ui";

function todoCount(t: AdminTask) {
  return Math.max(0, t.assigned - t.approved - t.submitted - t.doing);
}

function audienceLabel(t: AdminTask) {
  return t.class_names ?? t.class_name ?? "全部学员";
}

function DueText({ due }: { due: string | null }) {
  const info = dueInfo(due);
  if (!info) return <span className="text-muted-foreground">不限期</span>;
  return <span className={cn(info.tone === "destructive" ? "text-destructive" : info.tone === "warning" ? "text-warning" : "text-muted-foreground")}>{due}</span>;
}

function Completion({ task }: { task: AdminTask }) {
  return (
    <div className="flex flex-col gap-1.5">
      <StackedBar approved={task.approved} submitted={task.submitted} doing={task.doing} todo={todoCount(task)} />
      <span className="text-xs tabular-nums text-muted-foreground">
        {task.approved}/{task.assigned} 已完成 · {task.doing} 学习中
      </span>
    </div>
  );
}

interface SelectableProps {
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => void;
}

function SelectCheckbox({ task, selected, onToggleSelect }: { task: AdminTask } & SelectableProps) {
  return (
    <input
      type="checkbox"
      className="size-4 shrink-0 accent-primary"
      checked={!!selected}
      onChange={(e) => onToggleSelect?.(e.nativeEvent as MouseEvent)}
      aria-label={`选择任务 ${task.title}`}
    />
  );
}

export function AdminTaskCard({
  task,
  selectable,
  selected,
  onToggleSelect,
  onPin,
}: { task: AdminTask; onPin?: () => void } & SelectableProps) {
  const tags = splitTags(task.tech_tags);
  return (
    <div className={cn("group relative flex w-full flex-col rounded-xl border bg-card transition-colors hover:border-primary/40", selected && "border-primary bg-primary-soft/30")}>
      {selectable && (
        <label className="absolute top-4 left-3 z-10 flex cursor-pointer items-center">
          <SelectCheckbox task={task} selected={selected} onToggleSelect={onToggleSelect} />
        </label>
      )}
      <Link to={`/admin/tasks/${task.id}`} className={cn("flex w-full flex-1 flex-col gap-3 p-4", selectable && "pl-10")}>
        <div className="flex items-start justify-between gap-3">
          <h3 className="line-clamp-2 font-medium leading-snug text-pretty group-hover:text-primary">{task.title}</h3>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {!!task.pinned && (
              <Badge tone="primary">
                <Pin className="size-3" /> 置顶
              </Badge>
            )}
            {task.submitted > 0 && <Badge tone="warning">{task.submitted} 待审</Badge>}
            <PriorityBadge priority={task.priority} />
          </div>
        </div>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tags.slice(0, 5).map((tag) => (
              <TechTag key={tag}>{tag}</TechTag>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Users className="size-3.5" aria-hidden="true" />
            {audienceLabel(task)}
          </span>
          <span className="flex items-center gap-1">
            <CalendarClock className="size-3.5" aria-hidden="true" />
            <DueText due={task.due_date} />
          </span>
          <span>{task.step_count ? `${task.step_count} 个步骤` : "手动进度"}</span>
          {task.creator_name && <span>辅导员 {task.creator_name} 发布</span>}
        </div>
        <div className="mt-auto">
          <Completion task={task} />
        </div>
      </Link>
      {onPin && task.status === "published" && (
        <div className="flex items-center justify-end border-t px-3 py-1.5">
          <button
            type="button"
            onClick={onPin}
            className={cn("flex items-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-muted", task.pinned ? "text-primary" : "text-muted-foreground hover:text-foreground")}
          >
            <Pin className="size-3.5" /> {task.pinned ? "取消置顶" : "置顶"}
          </button>
        </div>
      )}
    </div>
  );
}

export function AdminTaskRow({
  task,
  selectable,
  selected,
  onToggleSelect,
  onPin,
}: { task: AdminTask; onPin?: () => void } & SelectableProps) {
  const tags = splitTags(task.tech_tags);
  return (
    <div className={cn("group flex items-stretch hover:bg-muted/40", selected && "bg-primary-soft/30")}>
      {selectable && (
        <label className="flex cursor-pointer items-center pl-5 pr-4">
          <SelectCheckbox task={task} selected={selected} onToggleSelect={onToggleSelect} />
        </label>
      )}
      <Link
        to={`/admin/tasks/${task.id}`}
        className={cn("flex flex-1 flex-col gap-3 py-3.5 pr-5 @lg:flex-row @lg:items-center @lg:gap-4", !selectable && "pl-5")}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium group-hover:text-primary">{task.title}</span>
            {!!task.pinned && <Pin className="size-3.5 shrink-0 text-primary" aria-label="置顶" />}
            <PriorityBadge priority={task.priority} />
            {task.submitted > 0 && <Badge tone="warning">{task.submitted} 待审</Badge>}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {tags.slice(0, 4).map((tag) => (
              <TechTag key={tag}>{tag}</TechTag>
            ))}
            <span className="text-xs text-muted-foreground">{task.step_count ? `${task.step_count} 个步骤` : "手动进度"}</span>
            {task.creator_name && <span className="text-xs text-muted-foreground">辅导员 {task.creator_name} 发布</span>}
          </div>
        </div>
        <div className="hidden w-24 shrink-0 truncate text-sm text-muted-foreground @3xl:block">{audienceLabel(task)}</div>
        <div className="w-24 shrink-0 text-sm whitespace-nowrap tabular-nums">
          <DueText due={task.due_date} />
        </div>
        <div className="flex shrink-0 items-center gap-3 @lg:w-44">
          <div className="flex-1">
            <Completion task={task} />
          </div>
          <ChevronRight className="hidden size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 @lg:block" aria-hidden="true" />
        </div>
      </Link>
      {onPin && task.status === "published" && (
        <div className="flex shrink-0 items-center pr-2">
          <button
            type="button"
            onClick={onPin}
            className={cn(
              "flex size-7 items-center justify-center rounded-md hover:bg-muted",
              task.pinned ? "text-primary" : "text-muted-foreground hover:text-foreground",
            )}
            title={task.pinned ? "取消置顶" : "置顶"}
            aria-label={task.pinned ? `取消置顶《${task.title}》` : `置顶《${task.title}》`}
          >
            <Pin className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

export function AdminTaskListHeader({
  selectable,
  allSelected,
  onToggleAll,
}: {
  selectable?: boolean;
  allSelected?: boolean;
  onToggleAll?: () => void;
}) {
  return (
    <div className="hidden items-center gap-4 border-b bg-muted/50 px-5 py-2.5 text-xs font-medium text-muted-foreground @lg:flex">
      {selectable && (
        <input type="checkbox" className="size-4 shrink-0 accent-primary" checked={!!allSelected} onChange={onToggleAll} aria-label="选择全部筛选结果" />
      )}
      <span className="flex-1">任务</span>
      <span className="hidden w-24 @3xl:block">发布范围</span>
      <span className="w-24">截止日期</span>
      <span className="w-44">完成情况</span>
    </div>
  );
}
