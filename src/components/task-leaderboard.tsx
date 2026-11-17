import useSWR from "swr";
import { Users } from "lucide-react";
import type { TaskLeaderboardData, TaskLeaderboardEntry } from "@/lib/types";
import { Avatar } from "@/components/avatar";
import { Badge, Card, CardHeader, EmptyState, Spinner } from "@/components/ui";
import { statusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";

export function taskLeaderboardKey(taskId: number | string) {
  return `/api/me/tasks/${taskId}/leaderboard`;
}

export function TaskLeaderboard({ taskId }: { taskId: number }) {
  const { data, error } = useSWR<TaskLeaderboardData>(taskLeaderboardKey(taskId));

  return (
    <Card>
      <CardHeader
        title="学习之星"
        description={data?.class_name ? `${data.class_name} · 本任务前 10` : "本任务完成排名"}
      />
      {error ? (
        <EmptyState icon={<Users />} title="排名加载失败" description="请稍后刷新重试" />
      ) : !data ? (
        <div className="flex justify-center px-5 py-8">
          <Spinner />
        </div>
      ) : !data.class_name ? (
        <EmptyState icon={<Users />} title="还没有分班" description="加入班级后即可查看本任务的学习之星排名" />
      ) : !data.top.length ? (
        <EmptyState icon={<Users />} title="暂无排名" description="班级里还没有可参与该任务的学员" />
      ) : (
        <LeaderboardBody data={data} />
      )}
    </Card>
  );
}

function LeaderboardBody({ data }: { data: TaskLeaderboardData }) {
  const me = data.me;
  return (
    <>
      <ol className="flex flex-col gap-1 p-2" aria-label="本任务学习之星排名">
        {data.top.map((row) => (
          <li key={row.id}>
            <LeaderboardRow row={row} />
          </li>
        ))}
      </ol>
      {me && !data.top.some((row) => row.id === me.id) && (
        <div className="border-t p-2">
          <p className="px-3 pb-1 pt-2 text-xs text-muted-foreground">我的排名</p>
          <LeaderboardRow row={me} />
        </div>
      )}
      {data.total > 10 && <p className="border-t px-5 py-2.5 text-xs text-muted-foreground">共 {data.total} 人参与本任务排名</p>}
    </>
  );
}

function LeaderboardRow({ row }: { row: TaskLeaderboardEntry }) {
  const meta = statusMeta(row.status);
  const showPercent = row.status === "doing" || row.status === "rejected";
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-3 py-2",
        row.is_me && "bg-primary-soft/60 ring-1 ring-primary/15 ring-inset",
      )}
    >
      <RankBadge rank={row.rank} />
      <Avatar name={row.name} avatarId={row.avatar_id} className="size-7 text-xs" />
      <p className="min-w-0 flex-1 truncate text-sm font-medium">
        {row.name}
        {row.is_me && <span className="ml-1.5 text-xs font-normal text-primary">我</span>}
      </p>
      <Badge tone={meta.tone}>{meta.label}</Badge>
      {showPercent && <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{row.percent}%</span>}
    </div>
  );
}

function RankBadge({ rank }: { rank: number }) {
  return (
    <span
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums",
        rank === 1 && "bg-warning text-white",
        rank === 2 && "bg-muted-foreground/25 text-foreground",
        rank === 3 && "bg-warning-soft text-warning",
        rank > 3 && "bg-muted text-muted-foreground",
      )}
    >
      {rank}
    </span>
  );
}
