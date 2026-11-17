import { Link } from "react-router";
import { AlarmClock, CalendarClock, ChevronRight, MessageSquareWarning, Pin } from "lucide-react";
import type { StudentTask } from "@/lib/types";
import { statusMeta } from "@/lib/status";
import { cn, dueInfo, splitTags } from "@/lib/utils";
import { Countdown, useNow } from "./countdown";
import { PriorityBadge } from "./priority-badge";
import { StarScore } from "./star-rating";
import { Badge, ProgressBar, TechTag } from "./ui";

function TaskMeta({ task }: { task: StudentTask }) {
  const due = task.status === "approved" ? null : dueInfo(task.due_date);
  if (task.status === "approved" && task.score) return <StarScore score={task.score} />;
  if (due) {
    return (
      <span className="flex items-center gap-1">
        <CalendarClock className="size-3.5" aria-hidden="true" />
        <span className={cn(due.tone === "destructive" && "text-destructive", due.tone === "warning" && "text-warning")}>{due.label}</span>
      </span>
    );
  }
  return <span>{task.step_count ? `${task.step_count} 个学习步骤` : "自定义进度"}</span>;
}

function UrgeNotice({ task, compact }: { task: StudentTask; compact?: boolean }) {
  if (!task.urge_due_at || task.status === "approved") return null;
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 rounded-lg bg-destructive-soft px-2.5 py-1.5 text-xs text-destructive",
        compact && "items-center",
      )}
    >
      <AlarmClock className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span className={cn("min-w-0", compact ? "flex flex-wrap items-center gap-x-1" : "flex flex-col gap-0.5")}>
        <span className="flex items-center gap-1">
          辅导员督促：<Countdown dueAt={task.urge_due_at} />
        </span>
        {task.urge_message && <span className={cn("font-normal text-destructive/80", compact ? "truncate" : "line-clamp-2")}>{task.urge_message}</span>}
      </span>
    </p>
  );
}

interface SelectableProps {
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => void;
}

function SelectCheckbox({ task, selected, onToggleSelect }: { task: StudentTask } & SelectableProps) {
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

export function StudentTaskCard({ task, selectable = false, selected = false, onToggleSelect }: { task: StudentTask } & SelectableProps) {
  const meta = statusMeta(task.status);
  const tags = splitTags(task.tech_tags);
  const now = useNow(30_000);
  const urged = !!task.urge_due_at && task.status !== "approved" && task.urge_due_at > now;

  return (
    <div
      className={cn(
        "group relative flex w-full flex-col rounded-xl border bg-card transition-colors hover:border-primary/40",
        urged && "border-destructive/40 bg-destructive-soft/20 ring-1 ring-destructive/15 hover:border-destructive/60",
        selected && "border-primary bg-primary-soft/30",
      )}
    >
      {selectable && (
        <label className="absolute top-4 left-3 z-10 flex cursor-pointer items-center">
          <SelectCheckbox task={task} selected={selected} onToggleSelect={onToggleSelect} />
        </label>
      )}
      <Link to={`/app/tasks/${task.id}`} className={cn("flex w-full flex-col gap-3 p-4", selectable && "pl-10")}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="line-clamp-2 font-medium leading-snug text-pretty group-hover:text-primary">{task.title}</h3>
            {tags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {tags.slice(0, 5).map((t) => (
                  <TechTag key={t}>{t}</TechTag>
                ))}
              </div>
            )}
            {task.creator_name && <p className="mt-1 text-xs text-muted-foreground">辅导员 {task.creator_name} 发布</p>}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {!!task.pinned && (
              <Badge tone="primary">
                <Pin className="size-3" /> 置顶
              </Badge>
            )}
            <Badge tone={meta.tone}>{meta.label}</Badge>
            <PriorityBadge priority={task.priority} />
          </div>
        </div>

        {task.status === "rejected" && task.review_comment && (
          <p className="flex items-start gap-1.5 rounded-lg bg-destructive-soft px-2.5 py-1.5 text-xs text-destructive">
            <MessageSquareWarning className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            <span className="line-clamp-2">{task.review_comment}</span>
          </p>
        )}

        <UrgeNotice task={task} />

        <div className="mt-auto flex items-center gap-3">
          <ProgressBar value={task.percent} tone={task.status === "submitted" ? "warning" : "primary"} label={`${task.title} 进度`} />
          <span className="w-10 text-right text-xs font-medium tabular-nums text-muted-foreground">{task.percent}%</span>
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <TaskMeta task={task} />
          <ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </div>
      </Link>
    </div>
  );
}

export function StudentTaskRow({ task, selectable = false, selected = false, onToggleSelect }: { task: StudentTask } & SelectableProps) {
  const meta = statusMeta(task.status);
  const tags = splitTags(task.tech_tags);
  const now = useNow(30_000);
  const urged = !!task.urge_due_at && task.status !== "approved" && task.urge_due_at > now;

  return (
    <div className={cn("group flex items-stretch hover:bg-muted/40", urged && "bg-destructive-soft/20 hover:bg-destructive-soft/30", selected && "bg-primary-soft/30")}>
      {selectable && (
        <label className="flex cursor-pointer items-center pr-3 pl-4">
          <SelectCheckbox task={task} selected={selected} onToggleSelect={onToggleSelect} />
        </label>
      )}
      <Link
        to={`/app/tasks/${task.id}`}
        className={cn("flex flex-1 flex-col gap-2 py-3 pr-4 @lg:flex-row @lg:items-center @lg:gap-4", !selectable && "pl-4")}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium group-hover:text-primary">{task.title}</span>
            {!!task.pinned && <Pin className="size-3.5 shrink-0 text-primary" aria-label="置顶" />}
            <PriorityBadge priority={task.priority} />
            {task.status === "rejected" && <MessageSquareWarning className="size-3.5 shrink-0 text-destructive" aria-label="有退回意见" />}
          </div>
          {tags.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {tags.slice(0, 4).map((t) => (
                <TechTag key={t}>{t}</TechTag>
              ))}
            </div>
          )}
          {task.creator_name && <p className="mt-1 text-xs text-muted-foreground">辅导员 {task.creator_name} 发布</p>}
          {task.urge_due_at && task.status !== "approved" && (
            <div className="mt-1.5 max-w-xl">
              <UrgeNotice task={task} compact />
            </div>
          )}
        </div>
        <div className="shrink-0 @lg:w-16">
          <Badge tone={meta.tone}>{meta.label}</Badge>
        </div>
        <div className="flex shrink-0 items-center gap-2 @lg:w-36">
          <ProgressBar value={task.percent} tone={task.status === "submitted" ? "warning" : "primary"} label={`${task.title} 进度`} />
          <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{task.percent}%</span>
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 text-xs whitespace-nowrap text-muted-foreground @lg:w-32">
          <TaskMeta task={task} />
          <ChevronRight className="size-4 shrink-0 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </div>
      </Link>
    </div>
  );
}

export function StudentTaskListHeader({
  selectable,
  allSelected,
  onToggleAll,
}: {
  selectable?: boolean;
  allSelected?: boolean;
  onToggleAll?: () => void;
}) {
  return (
    <div className="hidden items-center gap-4 border-b bg-muted/50 px-4 py-2.5 text-xs font-medium text-muted-foreground @lg:flex">
      {selectable && (
        <input type="checkbox" className="size-4 shrink-0 accent-primary" checked={!!allSelected} onChange={onToggleAll} aria-label="选择全部筛选结果" />
      )}
      <span className="flex-1">任务</span>
      <span className="w-16">状态</span>
      <span className="w-36">进度</span>
      <span className="w-32">截止 / 评分</span>
    </div>
  );
}
