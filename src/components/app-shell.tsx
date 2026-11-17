import { createContext, Suspense, useContext, useEffect, useState, type ComponentType } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { ChevronLeft, ChevronRight, KeyRound, LogOut, Maximize2, Minimize2, MoreHorizontal } from "lucide-react";
import { logout, useMe } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { Button, PageLoader } from "./ui";
import { Avatar } from "./avatar";
import { NotificationBell } from "./notification-bell";
import { AnnouncementBanner } from "./announcement-banner";
import { ChunkLoadedMarker } from "@/lib/chunk-reload";

export interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
  badge?: number;
}

/** 详情页与编辑页走宽容器；专注阅读只允许停留在详情页 */
const DETAIL_ROUTE = /^\/(app|admin)\/(tasks|shares)\/(?!new$)[^/]+(?:\/edit)?$/;
const READ_ROUTE = /^\/(app|admin)\/(tasks|shares)\/(?!new$)[^/]+$/;
const SIDEBAR_KEY = "st:sidebar";

interface ReadingModeValue {
  focus: boolean;
  setFocus: (value: boolean) => void;
  toggle: () => void;
}

const ReadingModeContext = createContext<ReadingModeValue | null>(null);

export function useReadingMode() {
  return useContext(ReadingModeContext);
}

/** 只有处于带导航的页面时才显示；独立分享页没有 Provider，自动隐藏 */
export function ReadingModeButton({ className }: { className?: string }) {
  const mode = useReadingMode();
  // 进入专注模式后由布局右上角的浮动按钮统一退出
  if (!mode || mode.focus) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={mode.toggle}
      className={className}
      title="隐藏导航与侧栏，专心阅读"
      aria-pressed={false}
    >
      <Maximize2 />
      专注阅读
    </Button>
  );
}

export function Logo({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2 font-semibold", className)}>
      <img src="/favicon.svg" alt="" className="size-7 shrink-0" />
      <span className={compact ? "sr-only" : undefined}>学迹</span>
    </div>
  );
}

const MOBILE_TABS = 5;

/** 专注模式下顶部细进度条，帮助判断长文阅读位置 */
function ReadingProgress() {
  const [value, setValue] = useState(0);
  useEffect(() => {
    function update() {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      setValue(scrollable > 0 ? Math.min(100, (window.scrollY / scrollable) * 100) : 0);
    }
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return <div className="fixed inset-x-0 top-0 z-50 h-0.5 bg-primary/80" style={{ width: `${value}%` }} aria-hidden="true" />;
}

export function AppShell({ nav, roleLabel }: { nav: NavItem[]; roleLabel: string }) {
  const { user } = useMe();
  const mobileTabs = nav.slice(0, MOBILE_TABS);
  const mobileMore = nav.slice(MOBILE_TABS);
  const navigate = useNavigate();
  const location = useLocation();
  const detailRoute = DETAIL_ROUTE.test(location.pathname);
  const readRoute = READ_ROUTE.test(location.pathname);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "rail";
    } catch {
      return false;
    }
  });
  const [focus, setFocus] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? "rail" : "full");
    } catch {
      // 隐私模式下 localStorage 可能不可写，忽略即可
    }
  }, [collapsed]);

  // 离开详情页（含进入编辑页）自动退出专注模式，避免导航被藏住
  useEffect(() => {
    if (focus && !readRoute) setFocus(false);
  }, [focus, readRoute]);

  useEffect(() => {
    if (!focus) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setFocus(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focus]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "[" || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      setCollapsed((value) => !value);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <ReadingModeContext.Provider value={{ focus, setFocus, toggle: () => setFocus((value) => !value) }}>
      {focus && <ReadingProgress />}
      {focus && (
        <button
          type="button"
          onClick={() => setFocus(false)}
          title="退出专注阅读（Esc）"
          className="fixed top-4 right-4 z-40 flex items-center gap-1.5 rounded-full border bg-card/95 px-3 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted hover:text-foreground"
        >
          <Minimize2 className="size-3.5" /> 退出专注
        </button>
      )}
      <div className="flex min-h-dvh flex-col">
      <AnnouncementBanner userId={user?.id} />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside
          className={cn(
            "sticky top-0 hidden h-dvh shrink-0 flex-col border-r bg-card transition-[width] duration-200 md:flex",
            collapsed ? "w-16" : "w-60",
            focus && "md:hidden",
          )}
        >
          <div className={cn("flex h-16 items-center", collapsed ? "justify-center px-2" : "justify-between pr-3 pl-5")}>
            <Logo compact={collapsed} />
            {!collapsed && <NotificationBell />}
          </div>
          {collapsed && (
            <div className="flex justify-center pb-2">
              <NotificationBell />
            </div>
          )}
          <nav className={cn("flex flex-1 flex-col gap-1", collapsed ? "px-2" : "px-3")} aria-label="主导航">
            {nav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                title={collapsed ? item.label : undefined}
                className={({ isActive }) =>
                  cn(
                    "relative flex items-center rounded-lg text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                    collapsed ? "justify-center px-0 py-2.5" : "gap-3 px-3 py-2",
                    isActive && "bg-primary-soft text-primary hover:bg-primary-soft hover:text-primary",
                  )
                }
              >
                <item.icon className="size-4 shrink-0" />
                {!collapsed && <span className="flex-1">{item.label}</span>}
                {!!item.badge &&
                  (collapsed ? (
                    <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-warning" aria-hidden="true" />
                  ) : (
                    <span className="rounded-full bg-warning px-1.5 text-[11px] leading-5 text-white tabular-nums">{item.badge}</span>
                  ))}
              </NavLink>
            ))}
          </nav>
          <div className={cn("border-t", collapsed ? "p-2" : "p-3")}>
            <div
              className={cn("flex items-center rounded-lg", collapsed ? "justify-center py-1" : "gap-3 px-2 py-2")}
              title={collapsed ? `${user?.name ?? ""} · ${roleLabel}` : undefined}
            >
              <Avatar name={user?.name ?? "?"} avatarId={user?.avatar_id} />
              {!collapsed && (
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{user?.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {roleLabel}
                    {user?.class_name ? ` · ${user.class_name}` : ""}
                  </p>
                </div>
              )}
            </div>
            {collapsed ? (
              <div className="mt-1 flex flex-col items-center gap-1">
                <NavLink
                  to="/account"
                  title="账号与头像"
                  aria-label="账号与头像"
                  className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <KeyRound className="size-3.5" />
                </NavLink>
                <button
                  onClick={handleLogout}
                  title="退出登录"
                  aria-label="退出登录"
                  className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <LogOut className="size-3.5" />
                </button>
              </div>
            ) : (
              <div className="mt-1 flex gap-1">
                <NavLink to="/account" className="flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
                  <KeyRound className="size-3.5" /> 账号与头像
                </NavLink>
                <button onClick={handleLogout} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
                  <LogOut className="size-3.5" /> 退出登录
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            title={collapsed ? "展开侧栏（[）" : "收起侧栏（[）"}
            aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
            className="absolute top-20 -right-3 z-20 hidden size-6 place-items-center rounded-full border bg-card text-muted-foreground shadow-sm transition-colors hover:text-foreground md:grid"
          >
            {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronLeft className="size-3.5" />}
          </button>
        </aside>

      <header className={cn("sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-card/90 px-4 backdrop-blur md:hidden", focus && "hidden")}>
        <Logo />
        <div className="flex items-center gap-1">
          <NotificationBell align="right" />
          {mobileMore.length > 0 && (
            <details className="group relative">
              <summary className="list-none rounded-lg p-2 text-muted-foreground hover:bg-muted [&::-webkit-details-marker]:hidden" aria-label="更多功能">
                <MoreHorizontal className="size-4" />
              </summary>
              <div className="absolute top-full right-0 z-50 mt-2 flex w-44 flex-col rounded-xl border bg-card p-1 shadow-xl">
                {mobileMore.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    onClick={(e) => e.currentTarget.closest("details")?.removeAttribute("open")}
                    className={({ isActive }) =>
                      cn("flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground", isActive && "text-primary")
                    }
                  >
                    <item.icon className="size-4" />
                    {item.label}
                  </NavLink>
                ))}
              </div>
            </details>
          )}
          <NavLink to="/account" className="rounded-lg p-2 text-muted-foreground hover:bg-muted" aria-label="账号与头像">
            <KeyRound className="size-4" />
          </NavLink>
          <button onClick={handleLogout} className="rounded-lg p-2 text-muted-foreground hover:bg-muted" aria-label="退出登录">
            <LogOut className="size-4" />
          </button>
        </div>
      </header>

      <main className={cn("min-w-0 flex-1 px-4 md:px-8", focus ? "py-6 pb-16" : "pt-5 pb-24 md:py-8")}>
        {/* 专注模式跟随窗口放宽，普通屏留白、宽屏接近满宽 */}
        <div className={cn("mx-auto", focus ? "max-w-[min(1400px,92vw)]" : detailRoute ? "max-w-7xl" : "max-w-6xl")}>
          <Suspense fallback={<PageLoader />}>
            <Outlet />
            <ChunkLoadedMarker />
          </Suspense>
        </div>
      </main>

      <nav
        className={cn(
          "fixed inset-x-0 bottom-0 z-30 flex border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden",
          focus && "hidden",
        )}
        aria-label="底部导航"
      >
        {mobileTabs.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn("relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] text-muted-foreground", isActive && "text-primary")
            }
          >
            <item.icon className="size-5" />
            {item.label}
            {!!item.badge && <span className="absolute top-1 left-1/2 ml-2 size-2 rounded-full bg-warning" aria-label={`${item.badge} 条待处理`} />}
          </NavLink>
        ))}
      </nav>
      </div>
      </div>
    </ReadingModeContext.Provider>
  );
}
