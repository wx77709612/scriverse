import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeSourceTexts } from "./source-text.js";

describe("AI 用户消息引用横幅", () => {
  it("透传流式消息 metadata 并渲染所有 @ 引用标签", async () => {
    const [page, application, styles] = normalizeSourceTexts(await Promise.all([
      readFile(join(process.cwd(), "src", "public", "index.html"), "utf8"),
      readFile(join(process.cwd(), "src", "public", "app.js"), "utf8"),
      readFile(join(process.cwd(), "src", "public", "styles.css"), "utf8")
    ]));

    expect(page).toContain('/styles.css?v=20260816-task-scope-volume-collapse-v2');
    expect(page).toContain('/app.js?v=20260816-extended-thinking-effort-v1');
    expect(page).toContain('feature=ai-roleplay-message-reference-v1');
    expect(page).toContain('feature=ai-all-message-references-v2');
    expect(page).toContain('feature=ai-inline-message-references-v1');
    expect(application).toContain('/ai-mentions.js?v=20260811-user-message-mentions-v1');
    expect(application).toContain("persistedUserMessage.createdAt, persistedUserMessage.metadata, persistedUserMessage.id");
    expect(application).toContain('["character", "角色", metadata?.mentionCharacterIds, state.characters]');
    expect(application).toContain('["race", "种族", metadata?.mentionRaceIds, state.races]');
    expect(application).toContain('["organization", "组织", metadata?.mentionOrganizationIds, state.organizations]');
    expect(application).toContain('const settingReferences = state.settings.map((setting) => ({ id: setting.id, name: setting.title }));');
    expect(application).toContain('["setting", "设定", metadata?.mentionSettingIds, settingReferences]');
    expect(application).toContain('["chapter", "章节", metadata?.mentionChapterIds, chapterReferences]');
    expect(application).toContain('["context-settings", "能力", metadata?.mentionContextSettingIds, contextSettingReferences]');
    expect(application).toContain('label.textContent = "引用";');
    expect(application).toContain('reference.setAttribute("aria-label", `${kind}：${name}`);');
    expect(application).toContain('canReadModule("races") ? api(`/api/works/${workId}/races`)');
    expect(application).toContain('canReadModule("organizations") ? apiAllPages(`/api/works/${workId}/organizations`)');
    expect(application).toContain("ensureAiReferencesLoaded()\n    ]);");
    expect(application).toContain("function aiPromptTextFromRange(range, prompt)");
    expect(application).toContain("function aiPromptTextBoundary(prompt, offset)");
    expect(application).toContain("function serializeAiReference(reference)");
    expect(application).toContain("function parseAiReferenceMarkup(value)");
    expect(application).toContain("function setAiPromptMarkup(value)");
    expect(application).toContain("function replaceAiReferenceMarkers(host, references)");
    expect(application).toContain("markup: aiPromptMarkup()");
    expect(application).toContain("const instruction = String(requestComposerSnapshot.markup ?? requestComposerSnapshot.text).trim();");
    expect(application).toContain("const cursorText = aiPromptTextFromRange(aiMentionRange, prompt);");
    expect(application).toContain("const startBoundary = aiPromptTextBoundary(prompt, localMention.start);");
    expect(application).toContain('references.className = "user-message-mentions";');
    expect(styles).toContain(".user-message-mentions { display: flex; align-items: center; flex-wrap: wrap;");
    expect(styles).toContain(".user-message-mention { min-width: 0; max-width: 100%;");
    expect(styles).toContain(".user-message-inline-mention { display: inline-flex;");
  });
});
