import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeSourceTexts } from "./source-text.js";

describe("AI 流连接耗时显示", () => {
  it("在连接状态后显示整数秒并固定三位数字宽度", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [page, application, styles] = normalizeSourceTexts(await Promise.all([
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]));

    expect(page).toContain("&feature=ai-stream-connection-seconds-v1");
    expect(application).toContain('meta.replaceChildren("正在请求…… ", connectionSeconds, " 秒")');
    expect(application).toContain("Math.floor((Date.now() - streamConnectionStartedAt) / 1000)");
    expect(application).toContain("let streamConnectionTimer = window.setInterval(renderStreamConnectionElapsed, 1000);");
    expect(application).toContain("window.clearInterval(streamConnectionTimer);");
    expect(application).toContain("streamConnectionTimer = null;");
    expect(application).toContain('new Set(["continuation", "delta", "process_step", "tool_call", "context_compacted", "complete", "request_status", "error"])');
    expect(application).toContain('if (streamConnectionEstablishedEvents.has(eventName) || eventName === "steer") {');
    expect(application).toContain("stopStreamConnectionTimer();\n        streamConnectionEstablished = true;");
    expect(styles).toContain(".message-meta .ai-stream-connection-seconds { display: inline-block; min-width: 3ch; font-variant-numeric: tabular-nums; text-align: right; }");
  });
});
