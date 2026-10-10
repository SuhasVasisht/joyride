import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../../src/ui/views/knowledge/ui";

describe("idea review links", () => {
  it("keeps ordered internal review links in the current Joyride tab", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: "1. [Current report](#/artifacts/current)\n2. [Earlier session](#/session/claude%3Aold) (Superseded history)." }));
    expect(html).toContain('<ol><li><a href="#/artifacts/current" rel="noreferrer">Current report</a>');
    expect(html).toContain('<a href="#/session/claude%3Aold" rel="noreferrer">Earlier session</a>');
    expect(html.indexOf("Current report")).toBeLessThan(html.indexOf("Earlier session"));
    expect(html).toContain("Superseded history");
    expect(html).not.toContain('target="_blank"');
  });

  it("opens external source links separately and treats HTML as text", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: "[Original page](https://claude.ai/code/artifact/example)\n\n<script>untrusted()</script>" }));
    expect(html).toContain('href="https://claude.ai/code/artifact/example" target="_blank"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});
