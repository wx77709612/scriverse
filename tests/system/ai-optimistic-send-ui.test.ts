import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeSourceText, normalizeSourceTexts } from "./source-text.js";

describe("AI 消息即时发送界面", () => {
  it("先渲染用户消息并清空输入框，再开始异步请求", async () => {
    const [application, page] = normalizeSourceTexts(await Promise.all([
      readFile(join(process.cwd(), "src", "public", "app.js"), "utf8"),
      readFile(join(process.cwd(), "src", "public", "index.html"), "utf8")
    ]));
    const sendSource = application.slice(
      application.indexOf("async function sendAiWithOptions"),
      application.indexOf("function createAiStreamCharacterCount")
    );
    const optimisticIndex = sendSource.indexOf('requestHolder.optimisticUserMessage = appendMessage(\n      "user"');
    const clearIndex = sendSource.indexOf("clearAiPromptComposer({ collapseScenePanel: Boolean(sceneDirection) })");
    const pendingIndex = sendSource.indexOf("requestHolder.pendingAssistantMessage = appendAiPendingRequestMessage(tab)");
    const modelLoadIndex = sendSource.indexOf("await ensureAiModelsLoaded()");

    expect(optimisticIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeGreaterThan(optimisticIndex);
    expect(pendingIndex).toBeGreaterThan(clearIndex);
    expect(modelLoadIndex).toBeGreaterThan(pendingIndex);
    expect(application).toContain('message.innerHTML = \'<div class="message-body" data-testid="ai-stream-content" aria-live="polite" aria-busy="true"></div><div class="message-meta">正在请求……</div>\'');
    expect(page).toContain("feature=ai-optimistic-send-v1");
  });

  it("用服务端确认消息替换临时气泡并在失败时显示错误卡片", async () => {
    const application = normalizeSourceText(await readFile(join(process.cwd(), "src", "public", "app.js"), "utf8"));

    expect(application).toContain("requestHolder.optimisticUserMessage.replaceWith(confirmedUserMessage)");
    expect(application).toContain("requestHolder.optimisticUserMessage = confirmedUserMessage");
    expect(application).toContain("if (!error?.streamInterruption) requestHolder.pendingAssistantMessage?.remove()");
    expect(application).toContain("function prefixAiRequestError(error, prefix)");
    expect(application).toContain("if (!requestHolder.optimisticUserMessage) return toast(failure.message, \"error\")");
    expect(application).toContain('requestHolder.optimisticUserMessage.dataset.status = "failed"');
    expect(application).toContain('appendMessage("assistant", failureMessage');
    expect(application).toContain("requestHolder.optimisticUserMessage?.remove();\n      setAiChatTabComposerSnapshot(tab, requestComposerSnapshot);");
    expect(application).toContain("if (warningOnly && messageMounted) message.remove()");
  });
});
