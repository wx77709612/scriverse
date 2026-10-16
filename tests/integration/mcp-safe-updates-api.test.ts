import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";
import { runWithRequestActor } from "../../src/request-context.js";

const setupToken = "mcp-safe-updates-setup-token-with-enough-length";
const masterSecret = "mcp-safe-updates-master-secret-with-enough-length";

type RegisteredFixture = {
  apiKey: string;
  user: {
    userId: string;
    username: string;
    displayName: string;
    role: "admin" | "user";
  };
  workId: string;
};

function createTestRuntime(): Runtime {
  return createRuntime({
    databasePath: ":memory:",
    masterSecret,
    serveUi: false,
    revealCaptchaAnswer: true,
    security: { allowRegistration: true, enforceSameOrigin: false, setupToken }
  });
}

async function solveCaptcha(runtime: Runtime): Promise<{ captchaId: string; captchaAnswer: string }> {
  const response = await request(runtime.app).get("/api/auth/captcha").expect(200);
  return { captchaId: String(response.body.data.captchaId), captchaAnswer: String(response.body.data.answer) };
}

async function registerFixture(runtime: Runtime, username: string): Promise<RegisteredFixture> {
  const agent = request.agent(runtime.app);
  const registration = await agent.post("/api/auth/register").send({
    username,
    password: "secure-password-123",
    passwordConfirmation: "secure-password-123",
    setupToken,
    ...await solveCaptcha(runtime)
  }).expect(201);
  const csrfToken = String(registration.body.data.csrfToken);
  const work = await agent.post("/api/works").set("X-CSRF-Token", csrfToken).send({ title: `${username} 的作品` }).expect(201);
  const key = await agent.post("/api/auth/api-key/reset").set("X-CSRF-Token", csrfToken).send({}).expect(200);
  return {
    apiKey: String(key.body.data.apiKey),
    user: registration.body.data.user,
    workId: String(work.body.data.id)
  };
}

describe("MCP 安全更新契约", () => {
  const runtimes: Runtime[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  });

  it("使用 expectedVersionNo 更新想法并拒绝过期版本与越权用户", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const owner = await registerFixture(runtime, "mcp_update_draft_owner");
    const outsider = await registerFixture(runtime, "mcp_update_draft_outsider");
    const draft = runWithRequestActor(owner.user, () => runtime.store.createDraft(owner.workId, {
      draftType: "setting",
      settingModule: "organizations",
      title: "观星会",
      content: "他们记录熄灭的恒星。"
    }));
    const draftId = String(draft.id);
    const updated = await request(runtime.app).patch(`/api/drafts/${draftId}`)
      .set("Authorization", `Bearer ${owner.apiKey}`)
      .send({ title: "观星会的密约", content: "他们记录每一颗熄灭的恒星。", changeNote: "补充组织秘密", expectedVersionNo: 1 })
      .expect(200);
    expect(updated.body.data).toMatchObject({ id: draftId, title: "观星会的密约", versionNo: 2 });

    const stale = await request(runtime.app).patch(`/api/drafts/${draftId}`)
      .set("Authorization", `Bearer ${owner.apiKey}`)
      .send({ title: "不得覆盖的新标题", expectedVersionNo: 1 }).expect(409);
    expect(stale.body.error).toMatchObject({ code: "VERSION_CONFLICT", details: { expectedVersionNo: 1, currentVersionNo: 2 } });
    await request(runtime.app).patch(`/api/drafts/${draftId}`)
      .set("Authorization", `Bearer ${outsider.apiKey}`)
      .send({ title: "越权修改", expectedVersionNo: 2 }).expect(403);

    expect(runtime.store.getDraft(draftId)).toMatchObject({ title: "观星会的密约", versionNo: 2 });
    expect(runtime.database.get(
      "SELECT version_no, created_by_user_id FROM entity_versions WHERE entity_type = 'draft' AND entity_id = ? ORDER BY version_no DESC LIMIT 1",
      draftId
    )).toEqual({ version_no: 2, created_by_user_id: owner.user.userId });
    expect(runtime.database.get("SELECT action, user_id FROM audit_logs WHERE entity_id = ? AND action = 'draft.updated'", draftId))
      .toEqual({ action: "draft.updated", user_id: owner.user.userId });
  });

  it("使用 expectedVersionNo 更新正式设定并保留版本与审计", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const owner = await registerFixture(runtime, "mcp_update_setting_owner");
    const outsider = await registerFixture(runtime, "mcp_update_setting_outsider");
    const setting = runWithRequestActor(owner.user, () => runtime.store.createSetting(owner.workId, {
      title: "灰烬航标",
      category: "科技",
      content: "航标以恒星灰烬校准。"
    }));
    const settingId = String(setting.id);
    const updated = await request(runtime.app).patch(`/api/settings/${settingId}`)
      .set("Authorization", `Bearer ${owner.apiKey}`)
      .send({ title: "灰烬航标协议", content: "灰烬航标需要两名领航员共同校准。", changeNote: "确认校准规则", expectedVersionNo: 1 })
      .expect(200);
    expect(updated.body.data).toMatchObject({ id: settingId, title: "灰烬航标协议", versionNo: 2 });

    const stale = await request(runtime.app).patch(`/api/settings/${settingId}`)
      .set("Authorization", `Bearer ${owner.apiKey}`)
      .send({ content: "不得覆盖的新内容", expectedVersionNo: 1 }).expect(409);
    expect(stale.body.error).toMatchObject({ code: "VERSION_CONFLICT", details: { expectedVersionNo: 1, currentVersionNo: 2 } });
    await request(runtime.app).patch(`/api/settings/${settingId}`)
      .set("Authorization", `Bearer ${outsider.apiKey}`)
      .send({ content: "越权修改", expectedVersionNo: 2 }).expect(403);

    expect(runtime.store.getSetting(settingId)).toMatchObject({ content: "灰烬航标需要两名领航员共同校准。", versionNo: 2 });
    expect(runtime.database.get(
      "SELECT version_no, created_by_user_id FROM entity_versions WHERE entity_type = 'setting' AND entity_id = ? ORDER BY version_no DESC LIMIT 1",
      settingId
    )).toEqual({ version_no: 2, created_by_user_id: owner.user.userId });
    expect(runtime.database.get("SELECT action, user_id FROM audit_logs WHERE entity_id = ? AND action = 'setting.updated'", settingId))
      .toEqual({ action: "setting.updated", user_id: owner.user.userId });
  });

  it("使用 expectedVersionNo 更新正式角色并拒绝跨作品关联", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const owner = await registerFixture(runtime, "mcp_update_character_owner");
    const outsider = await registerFixture(runtime, "mcp_update_character_outsider");
    const character = runWithRequestActor(owner.user, () => runtime.store.createCharacter(owner.workId, { name: "沈砚" }));
    const foreignRace = runWithRequestActor(outsider.user, () => runtime.store.createRace(outsider.workId, { name: "异乡种族" }));
    const characterId = String(character.id);
    const updated = await request(runtime.app).patch(`/api/characters/${characterId}`)
      .set("Authorization", `Bearer ${owner.apiKey}`)
      .send({ code: "领航者", aliases: ["阿砚"], changeNote: "补充角色代号", expectedVersionNo: 1 })
      .expect(200);
    expect(updated.body.data).toMatchObject({ id: characterId, code: "领航者", aliases: ["阿砚"], versionNo: 2 });

    const stale = await request(runtime.app).patch(`/api/characters/${characterId}`)
      .set("Authorization", `Bearer ${owner.apiKey}`)
      .send({ code: "不得覆盖", expectedVersionNo: 1 }).expect(409);
    expect(stale.body.error).toMatchObject({ code: "VERSION_CONFLICT", details: { expectedVersionNo: 1, currentVersionNo: 2 } });
    await request(runtime.app).patch(`/api/characters/${characterId}`)
      .set("Authorization", `Bearer ${owner.apiKey}`)
      .send({ raceId: foreignRace.id, expectedVersionNo: 2 }).expect(400);
    await request(runtime.app).patch(`/api/characters/${characterId}`)
      .set("Authorization", `Bearer ${outsider.apiKey}`)
      .send({ code: "越权修改", expectedVersionNo: 2 }).expect(403);

    expect(runtime.store.getCharacter(characterId)).toMatchObject({ code: "领航者", raceId: null, versionNo: 2 });
    expect(runtime.database.get(
      "SELECT version_no, created_by_user_id FROM character_versions WHERE character_id = ? ORDER BY version_no DESC LIMIT 1",
      characterId
    )).toEqual({ version_no: 2, created_by_user_id: owner.user.userId });
    expect(runtime.database.get("SELECT action, user_id FROM audit_logs WHERE entity_id = ? AND action = 'character.updated'", characterId))
      .toEqual({ action: "character.updated", user_id: owner.user.userId });
  });

  it("使用扩展资料自身 expectedVersionNo 更新角色资料", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const owner = await registerFixture(runtime, "mcp_update_character_section_owner");
    const outsider = await registerFixture(runtime, "mcp_update_character_section_outsider");
    const character = runWithRequestActor(owner.user, () => runtime.store.createCharacter(owner.workId, { name: "沈砚" }));
    const section = runWithRequestActor(owner.user, () => runtime.store.createCharacterProfileSection(String(character.id), {
      sectionType: "background",
      title: "远征经历",
      contentMarkdown: "沈砚参与过远征。"
    }));
    const sectionId = String(section.id);
    const updated = await request(runtime.app).patch(`/api/character-sections/${sectionId}`)
      .set("Authorization", `Bearer ${owner.apiKey}`)
      .send({ title: "远征前史", contentMarkdown: "沈砚曾参与第一次灰烬航标试验。", changeNote: "补充试验经历", expectedVersionNo: 1 })
      .expect(200);
    expect(updated.body.data).toMatchObject({ id: sectionId, title: "远征前史", versionNo: 2 });

    const stale = await request(runtime.app).patch(`/api/character-sections/${sectionId}`)
      .set("Authorization", `Bearer ${owner.apiKey}`)
      .send({ title: "不得覆盖", expectedVersionNo: 1 }).expect(409);
    expect(stale.body.error).toMatchObject({ code: "VERSION_CONFLICT", details: { expectedVersionNo: 1, currentVersionNo: 2 } });
    await request(runtime.app).patch(`/api/character-sections/${sectionId}`)
      .set("Authorization", `Bearer ${outsider.apiKey}`)
      .send({ title: "越权修改", expectedVersionNo: 2 }).expect(403);

    expect(runtime.store.getCharacterProfileSection(sectionId)).toMatchObject({ title: "远征前史", versionNo: 2 });
    expect(runtime.database.get(
      "SELECT version_no, created_by_user_id FROM character_profile_section_versions WHERE section_id = ? ORDER BY version_no DESC LIMIT 1",
      sectionId
    )).toEqual({ version_no: 2, created_by_user_id: owner.user.userId });
    expect(runtime.database.get("SELECT action, user_id FROM audit_logs WHERE entity_id = ? AND action = 'character-section.updated'", sectionId))
      .toEqual({ action: "character-section.updated", user_id: owner.user.userId });
  });

  it("使用 expectedVersionNo 更新正式种族并拒绝跨作品关联", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const owner = await registerFixture(runtime, "mcp_update_race_owner");
    const outsider = await registerFixture(runtime, "mcp_update_race_outsider");
    const race = runWithRequestActor(owner.user, () => runtime.store.createRace(owner.workId, { name: "星痕人" }));
    const foreignCharacter = runWithRequestActor(outsider.user, () => runtime.store.createCharacter(outsider.workId, { name: "异乡人" }));
    const raceId = String(race.id);
    const updated = await request(runtime.app).patch(`/api/races/${raceId}`)
      .set("Authorization", `Bearer ${owner.apiKey}`)
      .send({ name: "星痕遗民", description: "他们守护熄灭恒星的记录。", changeNote: "补充种族现状", expectedVersionNo: 1 })
      .expect(200);
    expect(updated.body.data).toMatchObject({ id: raceId, name: "星痕遗民", versionNo: 2 });

    const stale = await request(runtime.app).patch(`/api/races/${raceId}`)
      .set("Authorization", `Bearer ${owner.apiKey}`)
      .send({ description: "不得覆盖的新内容", expectedVersionNo: 1 }).expect(409);
    expect(stale.body.error).toMatchObject({ code: "VERSION_CONFLICT", details: { expectedVersionNo: 1, currentVersionNo: 2 } });
    await request(runtime.app).patch(`/api/races/${raceId}`)
      .set("Authorization", `Bearer ${owner.apiKey}`)
      .send({ memberIds: [foreignCharacter.id], expectedVersionNo: 2 }).expect(400);
    await request(runtime.app).patch(`/api/races/${raceId}`)
      .set("Authorization", `Bearer ${outsider.apiKey}`)
      .send({ description: "越权修改", expectedVersionNo: 2 }).expect(403);

    expect(runtime.store.getRace(raceId)).toMatchObject({ name: "星痕遗民", versionNo: 2 });
    expect(runtime.database.get(
      "SELECT version_no, created_by_user_id FROM entity_versions WHERE entity_type = 'race' AND entity_id = ? ORDER BY version_no DESC LIMIT 1",
      raceId
    )).toEqual({ version_no: 2, created_by_user_id: owner.user.userId });
    expect(runtime.database.get("SELECT action, user_id FROM audit_logs WHERE entity_id = ? AND action = 'race.updated'", raceId))
      .toEqual({ action: "race.updated", user_id: owner.user.userId });
  });

  it("使用 expectedVersionNo 更新正式组织并拒绝跨作品成员", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const owner = await registerFixture(runtime, "mcp_update_organization_owner");
    const outsider = await registerFixture(runtime, "mcp_update_organization_outsider");
    const organization = runWithRequestActor(owner.user, () => runtime.store.createOrganization(owner.workId, { name: "观星会" }));
    const foreignCharacter = runWithRequestActor(outsider.user, () => runtime.store.createCharacter(outsider.workId, { name: "异乡人" }));
    const organizationId = String(organization.id);
    const updated = await request(runtime.app).patch(`/api/organizations/${organizationId}`)
      .set("Authorization", `Bearer ${owner.apiKey}`)
      .send({ name: "新观星会", description: "他们保存熄灭恒星的观测记录。", changeNote: "更新组织章程", expectedVersionNo: 1 })
      .expect(200);
    expect(updated.body.data).toMatchObject({ id: organizationId, name: "新观星会", versionNo: 2 });

    const stale = await request(runtime.app).patch(`/api/organizations/${organizationId}`)
      .set("Authorization", `Bearer ${owner.apiKey}`)
      .send({ description: "不得覆盖的新内容", expectedVersionNo: 1 }).expect(409);
    expect(stale.body.error).toMatchObject({ code: "VERSION_CONFLICT", details: { expectedVersionNo: 1, currentVersionNo: 2 } });
    await request(runtime.app).patch(`/api/organizations/${organizationId}`)
      .set("Authorization", `Bearer ${owner.apiKey}`)
      .send({ memberIds: [foreignCharacter.id], expectedVersionNo: 2 }).expect(400);
    await request(runtime.app).patch(`/api/organizations/${organizationId}`)
      .set("Authorization", `Bearer ${outsider.apiKey}`)
      .send({ description: "越权修改", expectedVersionNo: 2 }).expect(403);

    expect(runtime.store.getOrganization(organizationId)).toMatchObject({ name: "新观星会", versionNo: 2 });
    expect(runtime.database.get(
      "SELECT version_no, created_by_user_id FROM entity_versions WHERE entity_type = 'organization' AND entity_id = ? ORDER BY version_no DESC LIMIT 1",
      organizationId
    )).toEqual({ version_no: 2, created_by_user_id: owner.user.userId });
    expect(runtime.database.get("SELECT action, user_id FROM audit_logs WHERE entity_id = ? AND action = 'organization.updated'", organizationId))
      .toEqual({ action: "organization.updated", user_id: owner.user.userId });
  });
});
