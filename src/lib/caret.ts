type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

const MIRROR_STYLES = [
  "boxSizing",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderStyle",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "letterSpacing",
  "lineHeight",
  "textAlign",
  "textIndent",
  "textTransform",
  "textRendering",
  "wordSpacing",
  "tabSize",
] as const;

/**
 * 根据鼠标在 textarea 中的落点估算光标位置。
 *
 * 浏览器没有提供直接把坐标映射到 textarea 文本偏移的 API，这里创建一个和
 * textarea 样式完全一致、覆盖在其上方的透明镜像元素，再用 caretPositionFromPoint
 * 读取镜像里的字符偏移。测量失败时返回 null，调用方可以退回当前光标位置。
 */
export function caretFromPoint(el: HTMLTextAreaElement, clientX: number, clientY: number): number | null {
  if (typeof document === "undefined") return null;
  const value = el.value;
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;

  const computed = window.getComputedStyle(el);
  const mirror = document.createElement("div");
  mirror.textContent = value || " ";

  for (const key of MIRROR_STYLES) mirror.style[key] = computed[key];
  mirror.style.position = "fixed";
  mirror.style.left = `${rect.left}px`;
  mirror.style.top = `${rect.top}px`;
  // 去掉可能存在的滚动条宽度，让换行位置和 textarea 一致
  const borderX = (parseFloat(computed.borderLeftWidth) || 0) + (parseFloat(computed.borderRightWidth) || 0);
  const borderY = (parseFloat(computed.borderTopWidth) || 0) + (parseFloat(computed.borderBottomWidth) || 0);
  const scrollbarX = Math.max(0, el.offsetWidth - el.clientWidth - borderX);
  const scrollbarY = Math.max(0, el.offsetHeight - el.clientHeight - borderY);
  mirror.style.width = `${Math.max(0, rect.width - scrollbarX)}px`;
  mirror.style.height = `${Math.max(0, rect.height - scrollbarY)}px`;
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.wordBreak = "break-word";
  mirror.style.overflow = "hidden";
  mirror.style.opacity = "0";
  mirror.style.background = "transparent";
  mirror.style.zIndex = "2147483647";
  mirror.style.margin = "0";

  document.body.appendChild(mirror);
  mirror.scrollTop = el.scrollTop;
  mirror.scrollLeft = el.scrollLeft;

  let offset: number | null = null;
  const doc = document as CaretDocument;
  try {
    if (doc.caretPositionFromPoint) {
      const pos = doc.caretPositionFromPoint(clientX, clientY);
      if (pos) {
        if (pos.offsetNode.nodeType === Node.TEXT_NODE) offset = pos.offset;
        else if (pos.offsetNode === mirror) offset = pos.offset > 0 ? value.length : 0;
      }
    }
    if (offset === null && doc.caretRangeFromPoint) {
      const range = doc.caretRangeFromPoint(clientX, clientY);
      if (range) {
        if (range.startContainer.nodeType === Node.TEXT_NODE) offset = range.startOffset;
        else if (range.startContainer === mirror) offset = range.startOffset > 0 ? value.length : 0;
      }
    }
  } finally {
    mirror.remove();
  }

  if (offset === null) return null;
  return Math.max(0, Math.min(value.length, offset));
}
