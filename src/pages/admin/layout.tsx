import useSWR from "swr";
import { BookOpen, ClipboardCheck, DatabaseBackup, Grid3x3, HardDrive, LayoutDashboard, ListTodo, Megaphone, ShieldCheck, Users } from "lucide-react";
import { AppShell, type NavItem } from "@/components/app-shell";
import { useMe } from "@/lib/auth";
import type { OverviewData } from "./overview";

export function AdminLayout() {
  const { data } = useSWR<OverviewData>("/api/admin/overview");
  const { user } = useMe();
  const nav: NavItem[] = [
    { to: "/admin", label: "概览", icon: LayoutDashboard, end: true },
    { to: "/admin/tasks", label: "学习任务", icon: ListTodo },
    { to: "/admin/shares", label: "分享资料", icon: BookOpen },
    { to: "/admin/reviews", label: "进度审核", icon: ClipboardCheck, badge: data?.counts.pending },
    { to: "/admin/students", label: "学员管理", icon: Users },
    { to: "/admin/matrix", label: "进度矩阵", icon: Grid3x3 },
    { to: "/admin/announcement", label: "全体通告", icon: Megaphone },
    ...(user?.is_super_admin
      ? [
          { to: "/admin/data", label: "数据备份", icon: DatabaseBackup },
          { to: "/admin/storage", label: "存储用量", icon: HardDrive },
          { to: "/admin/team", label: "团队与安全", icon: ShieldCheck },
        ]
      : []),
  ];
  return <AppShell nav={nav} roleLabel={user?.is_super_admin ? "管理员" : "辅导员"} />;
}