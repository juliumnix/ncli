import { expect, test } from "bun:test";
import { liveErrorHtml, liveLabel, liveShape, shimmerHtml } from "../src/live/shimmer";

test("shimmer label and shape follow the ncli kind", () => {
  expect(liveLabel("mermaid")).toBe("desenhando diagrama…");
  expect(liveShape("mermaid")).toBe("diagram");
  expect(liveLabel("react")).toBe("montando componente…");
  expect(liveShape("react")).toBe("card");
  expect(liveLabel("html", "<div>card</div>")).toBe("montando prévia…");
  expect(liveLabel("html", "<canvas class='chart'></canvas>")).toBe("desenhando gráfico…");
  expect(liveShape("html", "bar chart")).toBe("chart");
  expect(liveLabel("url")).toBe("carregando página…");
  expect(liveLabel("ui")).toBe("montando o card…");
  expect(liveShape("ui")).toBe("card");
});

test("shimmer html is a placeholder, not a live iframe", () => {
  const html = shimmerHtml("mermaid", "graph TD\nA -->");
  expect(html).toContain("desenhando diagrama…");
  expect(html).toContain('data-shape="diagram"');
  expect(html).toContain("aria-busy");
  expect(html).not.toContain("<iframe");
  expect(html).not.toContain("```");
});

test("a failed render shows the error and the raw source, escaped", () => {
  const html = liveErrorHtml("html", "<script>alert(1)</script>", "broken <tag>");
  expect(html).toContain("não deu para renderizar html");
  expect(html).toContain("broken &lt;tag&gt;");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
});
