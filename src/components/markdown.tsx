import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Copy, ListTree } from "lucide-react";
import { cn, copyText } from "@/lib/utils";
import { useLightbox, type LightboxImage } from "./lightbox";

/**
 * 轻量 Markdown 渲染器：只生成 React 节点，不使用 innerHTML，避免 XSS。
 * 支持标题、段落、换行、粗体 / 斜体 / 删除线、行内代码、代码块、链接、图片、
 * 有序 / 无序列表、任务列表、引用、分割线与表格。
 */

const SAFE_HREF = /^(https?:\/\/|\/|mailto:)/i;
const COLOR_VALUE = /^(#[0-9a-f]{3,8}|[a-z]+)$/i;

function safeHref(value: string): string | null {
  const v = value.trim();
  if (!v || /^(javascript|data|vbscript):/i.test(v)) return null;
  return SAFE_HREF.test(v) ? v : null;
}

/** 只接受十六进制或颜色名称，避免把任意 CSS 注入 style */
function safeColor(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v && COLOR_VALUE.test(v) ? v : undefined;
}

const INLINE_SOURCE =
  "`(?<code>[^`\\n]+)`|<font\\s+color\\s*=\\s*[\"']?(?<fontColor>#[0-9a-fA-F]{3,8}|[a-zA-Z]+)[\"']?\\s*>(?<fontText>[^<]*?)</font>|<span\\s+style\\s*=\\s*[\"'][^\"']*color\\s*:\\s*(?<spanColor>#[0-9a-fA-F]{3,8}|[a-zA-Z]+)[^\"']*[\"']\\s*>(?<spanText>[^<]*?)</span>|!\\[(?<alt>[^\\]]*)\\]\\((?<img>[^)\\s]+)(?:\\s+\"[^\"]*\")?\\)|\\[(?<text>[^\\]]+)\\]\\((?<href>[^)\\s]+)(?:\\s+\"[^\"]*\")?\\)|\\*\\*(?<bold>[^*]+)\\*\\*|__(?<bold2>[^_]+)__|~~(?<strike>[^~]+)~~|\\*(?<em>[^*\\n]+)\\*|_(?<em2>[^_\\n]+)_";

function MarkdownImage({ src, alt, images }: { src: string; alt: string; images: LightboxImage[] }) {
  const lightbox = useLightbox();
  const list = images.length ? images : [{ src, name: alt }];
  const index = Math.max(0, list.findIndex((image) => image.src === src));
  return (
    <button
      type="button"
      onClick={() => lightbox.open(list, index)}
      className="my-2 block max-w-full cursor-zoom-in text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      aria-label={alt ? `预览图片：${alt}` : "预览图片"}
      title="点击放大预览"
    >
      <img
        src={src}
        alt={alt}
        loading="lazy"
        className="h-auto max-h-[34rem] w-auto max-w-full rounded-lg border object-contain"
      />
    </button>
  );
}

function renderInline(text: string, keyPrefix: string, images: LightboxImage[] = []): ReactNode[] {
  const out: ReactNode[] = [];
  const inline = new RegExp(INLINE_SOURCE, "g");
  let last = 0;
  let index = 0;
  let match: RegExpExecArray | null;
  while ((match = inline.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const g = match.groups ?? {};
    const key = `${keyPrefix}-${index++}`;
    if (g.code !== undefined) {
      out.push(
        <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">
          {g.code}
        </code>,
      );
    } else if (g.fontText !== undefined || g.spanText !== undefined) {
      const color = safeColor(g.fontColor ?? g.spanColor);
      const content = g.fontText ?? g.spanText ?? "";
      out.push(
        <span key={key} style={color ? { color } : undefined}>
          {renderInline(content, key, images)}
        </span>,
      );
    } else if (g.img !== undefined) {
      const href = safeHref(g.img);
      out.push(
        href ? <MarkdownImage key={key} src={href} alt={g.alt ?? ""} images={images} /> : <span key={key}>{g.alt}</span>,
      );
    } else if (g.href !== undefined) {
      const href = safeHref(g.href);
      out.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2 break-all">
            {renderInline(g.text ?? "", key, images)}
          </a>
        ) : (
          <span key={key}>{g.text}</span>
        ),
      );
    } else if (g.bold !== undefined || g.bold2 !== undefined) {
      out.push(<strong key={key}>{renderInline(g.bold ?? g.bold2 ?? "", key, images)}</strong>);
    } else if (g.strike !== undefined) {
      out.push(<del key={key}>{renderInline(g.strike, key, images)}</del>);
    } else if (g.em !== undefined || g.em2 !== undefined) {
      out.push(<em key={key}>{renderInline(g.em ?? g.em2 ?? "", key, images)}</em>);
    }
    last = inline.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const HEADING_CLASS = [
  "text-xl font-semibold tracking-tight",
  "text-lg font-semibold",
  "text-base font-semibold",
  "text-sm font-semibold",
  "text-sm font-semibold",
  "text-xs font-semibold uppercase tracking-wide text-muted-foreground",
];

function Heading({ level, id, children }: { level: number; id?: string; children: ReactNode }) {
  const className = cn(HEADING_CLASS[level - 1] ?? HEADING_CLASS[2], "scroll-mt-20");
  switch (level) {
    case 1:
      return (
        <h1 id={id} className={className}>
          {children}
        </h1>
      );
    case 2:
      return (
        <h2 id={id} className={className}>
          {children}
        </h2>
      );
    case 3:
      return (
        <h3 id={id} className={className}>
          {children}
        </h3>
      );
    case 4:
      return (
        <h4 id={id} className={className}>
          {children}
        </h4>
      );
    case 5:
      return (
        <h5 id={id} className={className}>
          {children}
        </h5>
      );
    default:
      return (
        <h6 id={id} className={className}>
          {children}
        </h6>
      );
  }
}

interface HeadingEntry {
  id: string;
  level: number;
  text: string;
}

/** 把标题里的行内 Markdown 标记去掉，只留纯文本用于目录 */
function plainHeadingText(value: string): string {
  return value
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[^>]+>/g, "")
    .replace(/(\*\*|__|~~|\*|_)/g, "")
    .trim();
}

/** 扫描 Markdown 中所有顶格标题（跳过代码块），顺序与 parseBlocks 一致 */
function collectHeadings(source: string): { level: number; text: string }[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: { level: number; text: string }[] = [];
  let fenced = false;
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!match) continue;
    const text = plainHeadingText(match[2].replace(/\s+#+\s*$/, ""));
    if (text) out.push({ level: match[1].length, text });
  }
  return out;
}

/** 目录默认展示条数，超过后先折叠，避免长目录占用太多空间 */
const TOC_VISIBLE = 8;

function TableOfContents({ items }: { items: HeadingEntry[] }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const minLevel = Math.min(...items.map((item) => item.level));
  const visible = expanded ? items : items.slice(0, TOC_VISIBLE);
  const hidden = items.length - visible.length;

  function jump(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <nav aria-label="目录" className="self-start text-xs">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ListTree className="size-3.5" />
        <span className="font-medium">目录</span>
        <span className="tabular-nums opacity-70">{items.length}</span>
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="mt-1.5 max-h-56 w-64 max-w-full overflow-y-auto overscroll-contain rounded-lg border bg-muted/30 p-1">
          <ol className="flex flex-col">
            {visible.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => jump(item.id)}
                  title={item.text}
                  style={{ paddingLeft: `${(item.level - minLevel) * 12 + 8}px` }}
                  className="flex w-full items-center rounded-md py-1 pr-2 text-left text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
                >
                  <span className="truncate">{item.text}</span>
                </button>
              </li>
            ))}
          </ol>
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className="mt-0.5 w-full rounded-md px-2 py-1 text-left text-[11px] text-primary hover:bg-card"
            >
              {expanded ? "收起目录" : `展开全部（共 ${items.length} 条）`}
            </button>
          )}
        </div>
      )}
    </nav>
  );
}

function isTableSeparator(line: string): boolean {
  return line.includes("-") && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line);
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index];
  if (!line.trim()) return true;
  if (/^```/.test(line.trim())) return true;
  if (/^#{1,6}\s+/.test(line)) return true;
  if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) return true;
  if (/^\s*>\s?/.test(line)) return true;
  if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) return true;
  if (line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) return true;
  return false;
}

/** 代码块：右上角提供一键复制，复制成功后短暂显示「已复制」 */
function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    if (!(await copyText(code))) return;
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "已复制代码" : "复制代码"}
        title={copied ? "已复制" : "复制代码"}
        className={cn(
          "absolute top-1.5 right-1.5 inline-flex items-center gap-1 rounded-md border bg-card/90 px-1.5 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-card hover:text-foreground print:hidden",
          copied && "text-primary",
        )}
      >
        {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
        <span>{copied ? "已复制" : "复制"}</span>
      </button>
      <pre className="overflow-x-auto rounded-lg border bg-muted/70 p-3 pr-20 font-mono text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function parseBlocks(source: string, images: LightboxImage[] = [], headingIds?: string[]): ReactNode[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  let headingIndex = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = /^```([\w-]*)\s*$/.exec(line.trim());
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        code.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push(<CodeBlock key={`b${key++}`} code={code.join("\n")} />);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(
        <Heading key={`b${key++}`} level={heading[1].length} id={headingIds?.[headingIndex++]}>
          {renderInline(heading[2].replace(/\s+#+\s*$/, ""), `h${key}`, images)}
        </Heading>,
      );
      i++;
      continue;
    }

    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      blocks.push(<hr key={`b${key++}`} className="my-1 border-t" />);
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote key={`b${key++}`} className="border-l-2 border-primary/40 pl-3 text-muted-foreground">
          {parseBlocks(quote.join("\n"), images)}
        </blockquote>,
      );
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        if (left && right) return "text-center";
        if (right) return "text-right";
        return "text-left";
      });
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push(
        <div key={`b${key++}`} className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {header.map((cell, ci) => (
                  <th key={ci} className={cn("border px-2 py-1.5 font-medium", align[ci] ?? "text-left")}>
                    {renderInline(cell, `th${key}-${ci}`, images)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri}>
                  {header.map((_, ci) => (
                    <td key={ci} className={cn("border px-2 py-1.5 align-top", align[ci] ?? "text-left")}>
                      {renderInline(row[ci] ?? "", `td${key}-${ri}-${ci}`, images)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const listMatch = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2]);
      const items: { text: string; checked: boolean | null }[] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m && /\d/.test(m[2]) === ordered) {
          let text = m[3];
          let checked: boolean | null = null;
          const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
          if (task) {
            checked = task[1].toLowerCase() === "x";
            text = task[2];
          }
          items.push({ text, checked });
          i++;
          continue;
        }
        if (m) break;
        // 缩进续行归入上一项
        if (items.length && /^\s{2,}\S/.test(lines[i])) {
          items[items.length - 1].text += `\n${lines[i].trim()}`;
          i++;
          continue;
        }
        break;
      }
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag key={`b${key++}`} className={cn("flex flex-col gap-1 pl-5", ordered ? "list-decimal" : "list-disc")}>
          {items.map((item, ii) => (
            <li key={ii} className="leading-relaxed">
              {item.checked !== null ? (
                <span className="flex items-start gap-2">
                  <input type="checkbox" checked={item.checked} readOnly disabled className="mt-1 size-3.5 shrink-0 accent-primary" />
                  <span className={cn(item.checked && "text-muted-foreground line-through")}>{renderInline(item.text, `li${key}-${ii}`, images)}</span>
                </span>
              ) : (
                item.text.split("\n").map((part, pi) => (
                  <Fragment key={pi}>
                    {pi > 0 && <br />}
                    {renderInline(part, `li${key}-${ii}-${pi}`, images)}
                  </Fragment>
                ))
              )}
            </li>
          ))}
        </Tag>,
      );
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && !isBlockStart(lines, i)) {
      paragraph.push(lines[i]);
      i++;
    }
    // 防止遇到无法识别的块时死循环
    if (!paragraph.length) {
      paragraph.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={`b${key++}`} className="leading-relaxed text-pretty">
        {paragraph.map((part, pi) => (
          <Fragment key={pi}>
            {pi > 0 && <br />}
            {renderInline(part, `p${key}-${pi}`, images)}
          </Fragment>
        ))}
      </p>,
    );
  }

  return blocks;
}

export function Markdown({
  source,
  className,
  toc = false,
}: {
  source?: string | null;
  className?: string;
  /** 根据 Markdown 标题生成可折叠目录，适合任务说明、资料正文等长文 */
  toc?: boolean;
}) {
  const uid = useId();
  const prefix = useMemo(() => `md-${uid.replace(/[^a-zA-Z0-9_-]/g, "")}`, [uid]);
  const headings = useMemo<HeadingEntry[]>(() => {
    if (!toc || !source) return [];
    return collectHeadings(source).map((item, index) => ({ ...item, id: `${prefix}-h${index}` }));
  }, [toc, source, prefix]);
  const images = useMemo(() => {
    if (!source) return [];
    const list: LightboxImage[] = [];
    const pattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
      const href = safeHref(match[2]);
      if (href) list.push({ src: href, name: match[1] || href.split("/").pop() || "图片" });
    }
    return list;
  }, [source]);
  if (!source?.trim()) return null;
  return (
    <div className={cn("flex min-w-0 flex-col gap-2 text-sm break-words", className)}>
      {headings.length > 1 && <TableOfContents items={headings} />}
      {parseBlocks(
        source,
        images,
        headings.map((item) => item.id),
      )}
    </div>
  );
}
