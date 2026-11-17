import { useEffect, useState, type CSSProperties } from "react";
import useSWR from "swr";
import { Megaphone, X } from "lucide-react";
import { api } from "@/lib/api";

interface AnnouncementData {
  announcement: { content: string; updated_at: number } | null;
  show: boolean;
}

/** 把 Markdown 通告压缩成适合横幅滚动的一行纯文本 */
function toPlainText(source: string) {
  return source
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) => (alt ? `[图片：${alt}]` : "[图片]"))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[`*_~>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 全体通告横幅：固定在界面最顶部，用滚动字幕持续提示。
 * 关闭后仅在本次浏览器会话内隐藏，重新登录或通告更新后会再次出现。
 */
export function AnnouncementBanner({ userId }: { userId?: number }) {
  const { data } = useSWR<AnnouncementData>("/api/announcement", {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
  const content = data?.announcement?.content?.trim() ?? "";
  const version = data?.announcement?.updated_at ?? 0;
  // 按用户与通告版本区分：同一浏览器切换账号后，新用户仍能看到通告
  const storageKey = version ? `study-trail-announcement-banner-${userId ?? "guest"}-${version}` : "";
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!storageKey) {
      setDismissed(false);
      return;
    }
    setDismissed(sessionStorage.getItem(storageKey) === "1");
  }, [storageKey]);

  if (!content || dismissed) return null;

  const text = toPlainText(content);
  if (!text) return null;
  const duration = Math.min(70, Math.max(18, Math.round(text.length / 5)));
  const style = { "--announcement-duration": `${duration}s` } as CSSProperties;

  function dismiss() {
    if (storageKey) sessionStorage.setItem(storageKey, "1");
    setDismissed(true);
    // 同步记录已读，刷新后本次登录也不会再弹出通告弹窗
    void api.post("/api/announcement/ack").catch(() => {});
  }

  return (
    <div className="border-b border-warning/30 bg-warning-soft text-warning" role="status" aria-label="全体通告">
      <div className="flex items-center gap-2 px-3 py-1.5 md:px-5">
        <Megaphone className="size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="announcement-marquee flex w-max" style={style}>
            <span className="pr-20 text-sm font-medium whitespace-nowrap">{text}</span>
            <span className="pr-20 text-sm font-medium whitespace-nowrap" aria-hidden="true">
              {text}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 rounded-md p-1 text-warning/80 transition-colors hover:bg-warning/10 hover:text-warning"
          aria-label="关闭通告横幅"
          title="关闭通告横幅（本次会话不再显示）"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
