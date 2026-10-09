import { expect, test } from "bun:test";
import { renderMarkdown } from "../src/live/markdown";

test("renders bold, italic, code, lists, links and tables", () => {
  const html = renderMarkdown("**bold** and *it* and `code`\n\n- one\n- two\n\n[n](https://example.com)\n\n| a | b |\n| --- | --- |\n| 1 | 2 |");
  expect(html).toContain("<strong>bold</strong>");
  expect(html).toContain("<em>it</em>");
  expect(html).toContain("<code>code</code>");
  expect(html).toContain("<ul>");
  expect(html).toContain("<li>one</li>");
  expect(html).toContain('href="https://example.com"');
  expect(html).toContain("<table>");
  expect(html).toContain("<td>1</td>");
  expect(html).not.toContain("**bold**");
});

test("escapes raw HTML", () => {
  const html = renderMarkdown("<script>alert(1)</script> **ok**");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("<strong>ok</strong>");
});

test("partial markdown while streaming does not emit a broken strong tag", () => {
  const mid = renderMarkdown("hello **wor", true);
  expect(mid).toContain("hello");
  expect(mid).not.toContain("<strong>");
  const done = renderMarkdown("hello **world**", true);
  expect(done).toContain("<strong>world</strong>");
});

test("an open fence streams as a code block instead of leaking backticks", () => {
  const html = renderMarkdown("```js\nconst x = 1", true);
  expect(html).toContain("<pre");
  expect(html).toContain("const");
  expect(html).toContain("open");
  expect(html).not.toContain("```");
});
