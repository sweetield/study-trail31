import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const PASSWORD_HINT = "至少 8 位，需同时包含字母和数字";
export const PASSWORD_PATTERN = "(?=.*[A-Za-z])(?=.*\\d).{8,72}";

const PASSWORD_CHARS = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
const PASSWORD_DIGITS = "23456789";

/** 生成易读的初始密码：去掉 0/O、1/l/I 等易混淆字符，保证同时含字母和数字 */
export function generatePassword(length = 10) {
  const random = crypto.getRandomValues(new Uint32Array(length));
  const chars = Array.from(random, (n, i) => (i % 3 === 2 ? PASSWORD_DIGITS[n % PASSWORD_DIGITS.length] : PASSWORD_CHARS[n % PASSWORD_CHARS.length]));
  return chars.join("");
}

/** 全站统一按东八区（UTC+8）计算日期与时间，避免受设备时区影响 */
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 返回一个 Date，其 UTC 字段即东八区的年月日时分 */
export function shanghaiDate(d = new Date()) {
  return new Date(d.getTime() + TZ_OFFSET_MS);
}

/** 东八区当前小时（0-23） */
export function shanghaiHour(d = new Date()) {
  return shanghaiDate(d).getUTCHours();
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 将 shanghaiDate() 返回的日期格式化为 YYYY-MM-DD */
export function formatYmd(d: Date) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 东八区“今天”0 点（UTC 字段可直接用于日期加减） */
export function shanghaiToday() {
  const d = shanghaiDate();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function todayStr(d = new Date()) {
  return formatYmd(shanghaiDate(d));
}

export function formatTime(ts?: number | null) {
  if (!ts) return "—";
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(ts * 1000).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
}

export function formatMinutes(min: number) {
  if (!min) return "0 分钟";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} 分钟`;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

/** 学习日志允许时长为空，0 表示“未知” */
export function formatLogMinutes(min: number) {
  return min > 0 ? formatMinutes(min) : "未知";
}

export function dueInfo(due?: string | null): { label: string; tone: "muted" | "warning" | "destructive" } | null {
  if (!due) return null;
  const today = todayStr();
  const days = Math.round((new Date(due).getTime() - new Date(today).getTime()) / 86400000);
  if (days < 0) return { label: `已逾期 ${-days} 天`, tone: "destructive" };
  if (days === 0) return { label: "今天截止", tone: "warning" };
  if (days <= 3) return { label: `${days} 天后截止`, tone: "warning" };
  return { label: `${due} 截止`, tone: "muted" };
}

export function splitTags(tags?: string | null) {
  return (tags ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/**
 * 复制文本到剪贴板：优先使用异步剪贴板 API，失败时回退到临时 textarea，
 * 兼容非 HTTPS 或浏览器限制剪贴板权限的场景。返回是否复制成功。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续尝试回退方案
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-9999px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    try {
      area.select();
      return document.execCommand("copy");
    } finally {
      area.remove();
    }
  } catch {
    return false;
  }
}
