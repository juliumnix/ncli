(function (root) {
  const FENCE = /```([a-zA-Z0-9_-]*)[ \t]*\n([\s\S]*?)```/g;
  const OPEN_FENCE = /```([a-zA-Z0-9_-]*)[ \t]*\n([\s\S]*)$/;

  function renderMarkdown(src, streaming) {
    const text = src ?? "";
    const parts = [];
    let last = 0;
    FENCE.lastIndex = 0;
    let m;
    while ((m = FENCE.exec(text))) {
      if (m.index > last) parts.push(inlineBlock(text.slice(last, m.index), streaming && m.index === 0));
      parts.push(fenceHtml(m[1] || "", m[2] ?? ""));
      last = m.index + m[0].length;
    }
    const rest = text.slice(last);
    const open = streaming ? rest.match(OPEN_FENCE) : null;
    if (open) {
      const before = rest.slice(0, open.index);
      if (before) parts.push(inlineBlock(before, false));
      parts.push(fenceHtml(open[1] || "", open[2] ?? "", true));
    } else if (rest) {
      parts.push(inlineBlock(rest, streaming));
    }
    return parts.join("") || (streaming ? "" : "");
  }

  function inlineBlock(raw, streaming) {
    const blocks = raw.replace(/\r\n/g, "\n").split(/\n{2,}/);
    return blocks.map((block) => renderBlock(block, streaming && block === blocks[blocks.length - 1])).join("");
  }

  function renderBlock(block, streaming) {
    const trimmed = block.trim();
    if (!trimmed) return "";
    const lines = block.replace(/^\n+|\n+$/g, "").split("\n");
    if (isTable(lines)) return renderTable(lines);
    if (lines.every((l) => /^\s*[-*+]\s+/.test(l) || !l.trim())) return renderList(lines, false);
    if (lines.every((l) => /^\s*\d+\.\s+/.test(l) || !l.trim())) return renderList(lines, true);
    return `<p>${inline(lines.join("\n"), streaming)}</p>`;
  }

  function isTable(lines) {
    if (lines.length < 2) return false;
    if (!lines[0].includes("|") || !/^\s*\|?\s*:?-{3,}/.test(lines[1])) return false;
    return lines.every((l) => l.includes("|") || !l.trim());
  }

  function renderTable(lines) {
    const rows = lines.filter((l) => l.trim()).map(splitRow);
    const head = rows[0] || [];
    const body = rows.slice(2);
    const th = head.map((c) => `<th>${inline(c, false)}</th>`).join("");
    const tr = body.map((r) => `<tr>${r.map((c) => `<td>${inline(c, false)}</td>`).join("")}</tr>`).join("");
    return `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
  }

  function splitRow(line) {
    return line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  }

  function renderList(lines, ordered) {
    const tag = ordered ? "ol" : "ul";
    const items = lines
      .filter((l) => l.trim())
      .map((l) => l.replace(/^\s*(?:[-*+]|\d+\.)\s+/, ""))
      .map((l) => `<li>${inline(l, false)}</li>`)
      .join("");
    return `<${tag}>${items}</${tag}>`;
  }

  function fenceHtml(lang, code, open) {
    const highlighted = highlight(code.replace(/\n$/, ""), lang);
    const cls = [lang ? `lang-${escapeAttr(lang)}` : "", open ? "open" : ""].filter(Boolean).join(" ");
    return `<pre class="${cls}"><code>${highlighted}</code></pre>`;
  }

  function inline(src, streaming) {
    let s = escapeHtml(holdCodes(src, streaming));
    s = s.replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, '<img alt="$1" src="$2">');
    s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" rel="noreferrer" target="_blank">$1</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    if (!streaming || evenMarkers(src, "*")) s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    if (!streaming || evenMarkers(src, "_")) s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");
    s = restoreCodes(s);
    return s.replace(/\n/g, "<br>");
  }

  function holdCodes(src, streaming) {
    let s = src;
    if (streaming) {
      const ticks = (s.match(/`/g) || []).length;
      if (ticks % 2 === 1) s += "`";
    }
    return s;
  }

  function restoreCodes(s) {
    return s.replace(/`([^`]+)`/g, (_m, body) => `<code>${body}</code>`);
  }

  function evenMarkers(src, ch) {
    const re = ch === "*" ? /\*/g : /_/g;
    return ((src.match(re) || []).length & 1) === 0;
  }

  function highlight(code, lang) {
    const escaped = escapeHtml(code);
    if (!/^(js|ts|tsx|jsx|json|bash|sh)$/i.test(lang)) return escaped;
    return escaped
      .replace(/\b(const|let|var|function|return|if|else|for|while|class|export|import|from|async|await|type|interface|new|throw|try|catch)\b/g, "<span class=\"kw\">$1</span>")
      .replace(/(&quot;.*?&quot;|&#39;.*?&#39;)/g, "<span class=\"str\">$1</span>")
      .replace(/\b(\d+(?:\.\d+)?)\b/g, "<span class=\"num\">$1</span>");
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replaceAll("'", "&#39;");
  }

  root.renderMarkdown = renderMarkdown;
})(typeof window !== "undefined" ? window : globalThis);
