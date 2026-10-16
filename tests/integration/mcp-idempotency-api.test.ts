import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";
import { runWithRequestActor } from "../../src/request-context.js";
import { fullWorkModulePermissions } from "../../src/work-permissions.js";

const setupToken = "mcp-idempotency-setup-token-with-enough-length";
const masterSecret = "mcp-idempotency-master-secret-with-enough-length";

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

type IdempotentStore = {
  executeIdempotentMutation<T>(
    input: {
      workId: string;
      operation: string;
      idempotencyKey: string;
      requestHash: string;
    },
    operation: () => T
  ): { value: T; replayed: boolean };
};

function createTestRuntime(databasePath = ":memory:"): Runtime {
  return createRuntime({
    databasePath,
    masterSecret,
    serveUi: false,
    revealCaptchaAnswer: true,
    security: { allowRegistration: true, enforceSameOrigin: false, setupToken }
  });
}

async function solveCaptcha(runtime: Runtime): Promise<{ captchaId: string; captchaAnswer: string }> {
  const response = await request(runtime.app).get("/api/auth/captcha").expect(200);
  return {
    captchaId: String(response.body.data.captchaId),
    captchaAnswer: String(response.body.data.answer)
  };
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
  const work = await agent.post("/api/works")
    .set("X-CSRF-Token", csrfToken)
    .send({ title: "幂等测试作品" })
    .expect(201);
  const key = await agent.post("/api/auth/api-key/reset")
    .set("X-CSRF-Token", csrfToken)
    .send({})
    .expect(200);
  return {
    apiKey: String(key.body.data.apiKey),
    user: registration.body.data.user,
    workId: String(work.body.data.id)
  };
}

describe("MCP 写入幂等契约", () => {
  const runtimes: Runtime[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  });

  it("串行或并发重试相同请求时只创建一次并回放首次结果", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const fixture = await registerFixture(runtime, "idempotent_retry");
    const authorization = `Bearer ${fixture.apiKey}`;
    const serialKey = "mcp-draft-serial-0001";
    const payload = { draftType: "prose", title: "唯一草稿", content: "不会被重复创建。" };

    const first = await request(runtime.app).post(`/api/works/${fixture.workId}/drafts`)
      .set("Authorization", authorization)
      .set("Idempotency-Key", serialKey)
      .send(payload)
      .expect(201);
    const replayed = await request(runtime.app).post(`/api/works/${fixture.workId}/drafts`)
      .set("Authorization", authorization)
      .set("Idempotency-Key", serialKey)
      .send(payload)
      .expect(201);

    expect(replayed.body.data).toEqual(first.body.data);
    expect(first.headers["idempotency-replayed"]).toBe("false");
    expect(replayed.headers["idempotency-replayed"]).toBe("true");

    const concurrentKey = "mcp-draft-concurrent-0001";
    const concurrentPayload = { draftType: "setting", title: "并发草稿", content: "只保留一份。" };
    const [left, right] = await Promise.all([
      request(runtime.app).post(`/api/works/${fixture.workId}/drafts`)
        .set("Authorization", authorization)
        .set("Idempotency-Key", concurrentKey)
        .send(concurrentPayload),
      request(runtime.app).post(`/api/works/${fixture.workId}/drafts`)
        .set("Authorization", authorization)
        .set("Idempotency-Key", concurrentKey)
        .send(concurrentPayload)
    ]);

    expect([left.status, right.status]).toEqual([201, 201]);
    expect(left.body.data.id).toBe(right.body.data.id);
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM drafts WHERE work_id = ? AND title IN (?, ?)",
      fixture.workId,
      payload.title,
      concurrentPayload.title
    )).toEqual({ count: 2 });
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM entity_versions WHERE entity_type = 'draft' AND entity_id = ?",
      first.body.data.id
    )).toEqual({ count: 1 });
    expect(runtime.database.get(
      "SELECT action, user_id FROM audit_logs WHERE entity_id = ? AND action = 'draft.created'",
      first.body.data.id
    )).toEqual({ action: "draft.created", user_id: fixture.user.userId });
  });

  it("拒绝同一作用域内使用相同幂等键提交不同 payload", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const fixture = await registerFixture(runtime, "idempotent_conflict");
    const authorization = `Bearer ${fixture.apiKey}`;
    const idempotencyKey = "mcp-draft-conflict-0001";
    await request(runtime.app).post(`/api/works/${fixture.workId}/drafts`)
      .set("Authorization", authorization)
      .set("Idempotency-Key", idempotencyKey)
      .send({ draftType: "prose", title: "原始草稿", content: "原始内容。" })
      .expect(201);

    const conflict = await request(runtime.app).post(`/api/works/${fixture.workId}/drafts`)
      .set("Authorization", authorization)
      .set("Idempotency-Key", idempotencyKey)
      .send({ draftType: "prose", title: "篡改草稿", content: "不同内容。" })
      .expect(409);

    expect(conflict.body.error).toEqual({
      code: "IDEMPOTENCY_KEY_REUSED",
      message: "该幂等键已经用于不同的请求内容"
    });
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM drafts WHERE work_id = ?", fixture.workId)).toEqual({ count: 1 });
  });

  it("带幂等键创建重名想法时返回候选，明确确认后才新增", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const fixture = await registerFixture(runtime, "idempotent_duplicate");
    const authorization = `Bearer ${fixture.apiKey}`;
    const payload = { draftType: "setting", settingModule: "characters", title: "重名灵感", content: "第一种写法。" };
    await request(runtime.app).post(`/api/works/${fixture.workId}/drafts`)
      .set("Authorization", authorization)
      .set("Idempotency-Key", "mcp-draft-duplicate-seed-0001")
      .send(payload)
      .expect(201);

    const duplicate = await request(runtime.app).post(`/api/works/${fixture.workId}/drafts`)
      .set("Authorization", authorization)
      .set("Idempotency-Key", "mcp-draft-duplicate-new-0001")
      .send({ ...payload, content: "第二种写法。" })
      .expect(409);
    expect(duplicate.body.error).toMatchObject({
      code: "DUPLICATE_CANDIDATES",
      details: {
        candidates: [expect.objectContaining({ id: expect.any(String), entityType: "draft", title: "重名灵感", versionNo: 1 })]
      }
    });

    const confirmed = await request(runtime.app).post(`/api/works/${fixture.workId}/drafts`)
      .set("Authorization", authorization)
      .set("Idempotency-Key", "mcp-draft-duplicate-new-0001")
      .set("X-Scriverse-Duplicate-Policy", "create")
      .send({ ...payload, content: "第二种写法。" })
      .expect(201);
    expect(confirmed.body.data.id).not.toBe(duplicate.body.error.details.candidates[0].id);
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM drafts WHERE work_id = ? AND title = ?", fixture.workId, payload.title)).toEqual({ count: 2 });
  });

  it("幂等创建正式设定并在重名时返回候选，同时保留版本与审计", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const fixture = await registerFixture(runtime, "idempotent_setting");
    const authorization = `Bearer ${fixture.apiKey}`;
    const payload = { title: "灰烬航标", category: "科技", content: "以恒星灰烬校准。", tags: ["航行"] };
    const created = await request(runtime.app).post(`/api/works/${fixture.workId}/settings`)
      .set("Authorization", authorization)
      .set("Idempotency-Key", "mcp-setting-create-0001")
      .send(payload)
      .expect(201);
    const replayed = await request(runtime.app).post(`/api/works/${fixture.workId}/settings`)
      .set("Authorization", authorization)
      .set("Idempotency-Key", "mcp-setting-create-0001")
      .send(payload)
      .expect(201);
    expect(replayed.body.data).toEqual(created.body.data);
    expect(replayed.headers["idempotency-replayed"]).toBe("true");

    const duplicate = await request(runtime.app).post(`/api/works/${fixture.workId}/settings`)
      .set("Authorization", authorization)
      .set("Idempotency-Key", "mcp-setting-create-0002")
      .send({ ...payload, content: "另一种解释。" })
      .expect(409);
    expect(duplicate.body.error).toMatchObject({
      code: "DUPLICATE_CANDIDATES",
      details: { candidates: [expect.objectContaining({ id: created.body.data.id, entityType: "setting", title: payload.title, versionNo: 1 })] }
    });
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM entity_versions WHERE entity_type = 'setting' AND entity_id = ?",
      created.body.data.id
    )).toEqual({ count: 1 });
    expect(runtime.database.get(
      "SELECT action, user_id FROM audit_logs WHERE entity_id = ? AND action = 'setting.created'",
      created.body.data.id
    )).toEqual({ action: "setting.created", user_id: fixture.user.userId });
  });

  it("幂等创建正式角色并在名称或别名冲突时返回候选", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const fixture = await registerFixture(runtime, "idempotent_character");
    const authorization = `Bearer ${fixture.apiKey}`;
    const payload = { name: "沈砚", gender: "female", aliases: ["领航员"] };
    const created = await request(runtime.app).post(`/api/works/${fixture.workId}/characters`)
      .set("Authorization", authorization)
      .set("Idempotency-Key", "mcp-character-create-0001")
      .send(payload)
      .expect(201);
    const replayed = await request(runtime.app).post(`/api/works/${fixture.workId}/characters`)
      .set("Authorization", authorization)
      .set("Idempotency-Key", "mcp-character-create-0001")
      .send(payload)
      .expect(201);
    expect(replayed.body.data).toEqual(created.body.data);

    const conflict = await request(runtime.app).post(`/api/works/${fixture.workId}/characters`)
      .set("Authorization", authorization)
      .set("Idempotency-Key", "mcp-character-create-0002")
      .send({ name: "新角色", aliases: ["领航员"] })
      .expect(409);
    expect(conflict.body.error).toMatchObject({
      code: "DUPLICATE_CANDIDATES",
      details: {
        candidates: [expect.objectContaining({ id: created.body.data.id, entityType: "character", name: "沈砚", versionNo: 1 })]
      }
    });
    expect(runtime.database.get(
      "SELECT version_no, created_by_user_id FROM character_versions WHERE character_id = ?",
      created.body.data.id
    )).toEqual({ version_no: 1, created_by_user_id: fixture.user.userId });
    expect(runtime.database.get(
      "SELECT action, user_id FROM audit_logs WHERE entity_id = ? AND action = 'character.created'",
      created.body.data.id
    )).toEqual({ action: "character.created", user_id: fixture.user.userId });
  });

  it("幂等创建角色扩展资料并在同角色章节重名时返回候选", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const fixture = await registerFixture(runtime, "idempotent_character_section");
    const character = runtime.store.createCharacter(fixture.workId, { name: "沈砚" });
    const authorization = `Bearer ${fixture.apiKey}`;
    const payload = { sectionType: "background", title: "灰烬航标事故", contentMarkdown: "她是唯一的幸存者。" };
    const created = await request(runtime.app).post(`/api/characters/${character.id}/sections`)
      .set("Authorization", authorization)
      .set("Idempotency-Key", "mcp-character-section-0001")
      .send(payload)
      .expect(201);
    const replayed = await request(runtime.app).post(`/api/characters/${character.id}/sections`)
      .set("Authorization", authorization)
      .set("Idempotency-Key", "mcp-character-section-0001")
      .send(payload)
      .expect(201);
    expect(replayed.body.data).toEqual(created.body.data);

    const duplicate = await request(runtime.app).post(`/api/characters/${character.id}/sections`)
      .set("Authorization", authorization)
      .set("Idempotency-Key", "mcp-character-section-0002")
      .send({ ...payload, contentMarkdown: "另一份描述。" })
      .expect(409);
    expect(duplicate.body.error).toMatchObject({
      code: "DUPLICATE_CANDIDATES",
      details: { candidates: [expect.objectContaining({ id: created.body.data.id, entityType: "character-section", title: payload.title, versionNo: 1 })] }
    });
    expect(runtime.database.get(
      "SELECT version_no, created_by_user_id FROM character_profile_section_versions WHERE section_id = ?",
      created.body.data.id
    )).toEqual({ version_no: 1, created_by_user_id: fixture.user.userId });
    expect(runtime.database.get(
      "SELECT action, user_id FROM audit_logs WHERE entity_id = ? AND action = 'character-section.created'",
      created.body.data.id
    )).toEqual({ action: "character-section.created", user_id: fixture.user.userId });
  });

  it("幂等创建正式种族并在重名时返回候选", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const fixture = await registerFixture(runtime, "idempotent_race");
    const authorization = `Bearer ${fixture.apiKey}`;
    const payload = { name: "星裔", description: "诞生于恒星灰烬。" };
    const created = await request(runtime.app).post(`/api/works/${fixture.workId}/races`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-race-create-0001").send(payload).expect(201);
    const replayed = await request(runtime.app).post(`/api/works/${fixture.workId}/races`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-race-create-0001").send(payload).expect(201);
    expect(replayed.body.data).toEqual(created.body.data);
    const duplicate = await request(runtime.app).post(`/api/works/${fixture.workId}/races`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-race-create-0002").send(payload).expect(409);
    expect(duplicate.body.error).toMatchObject({
      code: "DUPLICATE_CANDIDATES",
      details: { candidates: [expect.objectContaining({ id: created.body.data.id, entityType: "race", name: "星裔", versionNo: 1 })] }
    });
    expect(runtime.database.get("SELECT action, user_id FROM audit_logs WHERE entity_id = ? AND action = 'race.created'", created.body.data.id))
      .toEqual({ action: "race.created", user_id: fixture.user.userId });
  });

  it("幂等创建正式组织并拒绝重名和跨作品成员", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const fixture = await registerFixture(runtime, "idempotent_organization");
    const other = await registerFixture(runtime, "idempotent_organization_other");
    const authorization = `Bearer ${fixture.apiKey}`;
    const otherCharacter = await request(runtime.app).post(`/api/works/${other.workId}/characters`)
      .set("Authorization", `Bearer ${other.apiKey}`)
      .set("Idempotency-Key", "mcp-organization-other-character-0001")
      .send({ name: "他作成员" })
      .expect(201);
    const payload = { name: "归航委员会", description: "负责审核舰队归航路线。" };
    const created = await request(runtime.app).post(`/api/works/${fixture.workId}/organizations`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-organization-create-0001").send(payload).expect(201);
    const replayed = await request(runtime.app).post(`/api/works/${fixture.workId}/organizations`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-organization-create-0001").send(payload).expect(201);
    expect(replayed.body.data).toEqual(created.body.data);
    expect(replayed.headers["idempotency-replayed"]).toBe("true");

    const duplicate = await request(runtime.app).post(`/api/works/${fixture.workId}/organizations`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-organization-create-0002").send(payload).expect(409);
    expect(duplicate.body.error).toMatchObject({
      code: "DUPLICATE_CANDIDATES",
      details: { candidates: [expect.objectContaining({ id: created.body.data.id, entityType: "organization", name: payload.name, versionNo: 1 })] }
    });

    await request(runtime.app).post(`/api/works/${fixture.workId}/organizations`)
      .set("Authorization", authorization)
      .set("Idempotency-Key", "mcp-organization-cross-work-0001")
      .send({ name: "越界组织", memberIds: [otherCharacter.body.data.id] })
      .expect(400);
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM organizations WHERE work_id = ?", fixture.workId)).toEqual({ count: 1 });
    expect(runtime.database.get(
      "SELECT version_no, created_by_user_id FROM entity_versions WHERE entity_type = 'organization' AND entity_id = ?",
      created.body.data.id
    )).toEqual({ version_no: 1, created_by_user_id: fixture.user.userId });
    expect(runtime.database.get("SELECT action, user_id FROM audit_logs WHERE entity_id = ? AND action = 'organization.created'", created.body.data.id))
      .toEqual({ action: "organization.created", user_id: fixture.user.userId });
  });

  it("幂等创建时间轴轨道并在重名时返回候选", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const fixture = await registerFixture(runtime, "idempotent_timeline_track");
    const authorization = `Bearer ${fixture.apiKey}`;
    const payload = { name: "归航纪年", description: "记录舰队返航过程。", sortOrder: 2 };
    const created = await request(runtime.app).post(`/api/works/${fixture.workId}/timeline-tracks`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-timeline-track-create-0001").send(payload).expect(201);
    const replayed = await request(runtime.app).post(`/api/works/${fixture.workId}/timeline-tracks`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-timeline-track-create-0001").send(payload).expect(201);
    expect(replayed.body.data).toEqual(created.body.data);
    expect(replayed.headers["idempotency-replayed"]).toBe("true");

    const duplicate = await request(runtime.app).post(`/api/works/${fixture.workId}/timeline-tracks`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-timeline-track-create-0002").send(payload).expect(409);
    expect(duplicate.body.error).toMatchObject({
      code: "DUPLICATE_CANDIDATES",
      details: { candidates: [expect.objectContaining({ id: created.body.data.id, entityType: "timeline-track", name: payload.name, versionNo: 1 })] }
    });
    expect(runtime.database.get(
      "SELECT version_no, created_by_user_id FROM entity_versions WHERE entity_type = 'timeline-track' AND entity_id = ?",
      created.body.data.id
    )).toEqual({ version_no: 1, created_by_user_id: fixture.user.userId });
    expect(runtime.database.get("SELECT action, user_id FROM audit_logs WHERE entity_id = ? AND action = 'timeline-track.created'", created.body.data.id))
      .toEqual({ action: "timeline-track.created", user_id: fixture.user.userId });
  });

  it("幂等创建时间轴事件并拒绝跨作品轨道、章节和参与角色", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const fixture = await registerFixture(runtime, "idempotent_timeline_event");
    const other = await registerFixture(runtime, "idempotent_timeline_event_other");
    const authorization = `Bearer ${fixture.apiKey}`;
    const localTrack = runWithRequestActor(fixture.user, () => runtime.store.createTimelineTrack(fixture.workId, { name: "归航纪年" }));
    const foreignTrack = runWithRequestActor(other.user, () => runtime.store.createTimelineTrack(other.workId, { name: "他作纪年" }));
    const foreignVolume = runWithRequestActor(other.user, () => runtime.store.createVolume(other.workId, { title: "他作卷" }));
    const foreignChapter = runWithRequestActor(other.user, () => runtime.store.createChapter(other.workId, {
      volumeId: String(foreignVolume.id),
      title: "他作章节"
    }));
    const foreignCharacter = runWithRequestActor(other.user, () => runtime.store.createCharacter(other.workId, { name: "他作角色" }));
    const payload = { name: "灰烬跃迁", trackId: localTrack.id, timeLabel: "新历 17 年" };
    const created = await request(runtime.app).post(`/api/works/${fixture.workId}/timeline`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-timeline-event-create-0001").send(payload).expect(201);
    const replayed = await request(runtime.app).post(`/api/works/${fixture.workId}/timeline`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-timeline-event-create-0001").send(payload).expect(201);
    expect(replayed.body.data).toEqual(created.body.data);

    const duplicate = await request(runtime.app).post(`/api/works/${fixture.workId}/timeline`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-timeline-event-create-0002").send(payload).expect(409);
    expect(duplicate.body.error).toMatchObject({
      code: "DUPLICATE_CANDIDATES",
      details: { candidates: [expect.objectContaining({ id: created.body.data.id, entityType: "timeline-event", name: payload.name, versionNo: 1 })] }
    });

    for (const [key, invalidPayload] of [
      ["track", { name: "跨作品轨道", trackId: foreignTrack.id }],
      ["chapter", { name: "跨作品章节", chapterIds: [foreignChapter.id] }],
      ["character", { name: "跨作品角色", participantIds: [foreignCharacter.id] }]
    ] as const) {
      await request(runtime.app).post(`/api/works/${fixture.workId}/timeline`)
        .set("Authorization", authorization)
        .set("Idempotency-Key", `mcp-timeline-event-invalid-${key}`)
        .send(invalidPayload)
        .expect(400);
    }
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM timeline_events WHERE work_id = ?", fixture.workId)).toEqual({ count: 1 });
    expect(runtime.database.get(
      "SELECT version_no, created_by_user_id FROM entity_versions WHERE entity_type = 'timeline-event' AND entity_id = ?",
      created.body.data.id
    )).toEqual({ version_no: 1, created_by_user_id: fixture.user.userId });
    expect(runtime.database.get("SELECT action, user_id FROM audit_logs WHERE entity_id = ? AND action = 'timeline.created'", created.body.data.id))
      .toEqual({ action: "timeline.created", user_id: fixture.user.userId });
  });

  it("幂等创建人物关系并拒绝重复关系和跨作品角色", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const fixture = await registerFixture(runtime, "idempotent_relationship");
    const other = await registerFixture(runtime, "idempotent_relationship_other");
    const authorization = `Bearer ${fixture.apiKey}`;
    const from = runWithRequestActor(fixture.user, () => runtime.store.createCharacter(fixture.workId, { name: "沈砚" }));
    const to = runWithRequestActor(fixture.user, () => runtime.store.createCharacter(fixture.workId, { name: "林渡" }));
    const foreign = runWithRequestActor(other.user, () => runtime.store.createCharacter(other.workId, { name: "他作角色" }));
    const payload = {
      fromCharacterId: from.id,
      toCharacterId: to.id,
      category: "social",
      subtype: "导师",
      directed: true,
      confirmationStatus: "confirmed"
    };
    const created = await request(runtime.app).post(`/api/works/${fixture.workId}/relationships`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-relationship-create-0001").send(payload).expect(201);
    const replayed = await request(runtime.app).post(`/api/works/${fixture.workId}/relationships`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-relationship-create-0001").send(payload).expect(201);
    expect(replayed.body.data).toEqual(created.body.data);

    const duplicate = await request(runtime.app).post(`/api/works/${fixture.workId}/relationships`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-relationship-create-0002").send(payload).expect(409);
    expect(duplicate.body.error).toMatchObject({
      code: "DUPLICATE_CANDIDATES",
      details: { candidates: [expect.objectContaining({ id: created.body.data.id, entityType: "relationship", versionNo: 1 })] }
    });
    await request(runtime.app).post(`/api/works/${fixture.workId}/relationships`)
      .set("Authorization", authorization)
      .set("Idempotency-Key", "mcp-relationship-cross-work-0001")
      .send({ ...payload, toCharacterId: foreign.id })
      .expect(400);
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM relationships WHERE work_id = ?", fixture.workId)).toEqual({ count: 1 });
    expect(runtime.database.get(
      "SELECT version_no, created_by_user_id FROM entity_versions WHERE entity_type = 'relationship' AND entity_id = ?",
      created.body.data.id
    )).toEqual({ version_no: 1, created_by_user_id: fixture.user.userId });
    expect(runtime.database.get("SELECT action, user_id FROM audit_logs WHERE entity_id = ? AND action = 'relationship.created'", created.body.data.id))
      .toEqual({ action: "relationship.created", user_id: fixture.user.userId });
  });

  it("幂等创建分卷并在同名时返回候选", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const fixture = await registerFixture(runtime, "idempotent_volume");
    const authorization = `Bearer ${fixture.apiKey}`;
    const payload = { title: "第二卷 归航", kind: "main", description: "舰队返回故乡。", keywords: ["归航"] };
    const created = await request(runtime.app).post(`/api/works/${fixture.workId}/volumes`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-volume-create-0001").send(payload).expect(201);
    const replayed = await request(runtime.app).post(`/api/works/${fixture.workId}/volumes`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-volume-create-0001").send(payload).expect(201);
    expect(replayed.body.data).toEqual(created.body.data);

    const duplicate = await request(runtime.app).post(`/api/works/${fixture.workId}/volumes`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-volume-create-0002").send(payload).expect(409);
    expect(duplicate.body.error).toMatchObject({
      code: "DUPLICATE_CANDIDATES",
      details: { candidates: [expect.objectContaining({ id: created.body.data.id, entityType: "volume", title: payload.title, versionNo: 1 })] }
    });
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM volumes WHERE work_id = ? AND deleted_at IS NULL", fixture.workId)).toEqual({ count: 1 });
    expect(runtime.database.get(
      "SELECT version_no, created_by_user_id FROM entity_versions WHERE entity_type = 'volume' AND entity_id = ?",
      created.body.data.id
    )).toEqual({ version_no: 1, created_by_user_id: fixture.user.userId });
    expect(runtime.database.get("SELECT action, user_id FROM audit_logs WHERE entity_id = ? AND action = 'volume.created'", created.body.data.id))
      .toEqual({ action: "volume.created", user_id: fixture.user.userId });
  });

  it("幂等创建章节并拒绝跨作品分卷与插入锚点", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const fixture = await registerFixture(runtime, "idempotent_chapter");
    const other = await registerFixture(runtime, "idempotent_chapter_other");
    const authorization = `Bearer ${fixture.apiKey}`;
    const volume = runWithRequestActor(fixture.user, () => runtime.store.createVolume(fixture.workId, { title: "第一卷" }));
    const foreignVolume = runWithRequestActor(other.user, () => runtime.store.createVolume(other.workId, { title: "他作卷" }));
    const foreignChapter = runWithRequestActor(other.user, () => runtime.store.createChapter(other.workId, {
      volumeId: String(foreignVolume.id),
      title: "他作章节"
    }));
    const payload = {
      volumeId: volume.id,
      title: "第一章 归航",
      content: "舰队驶入最后一片灰烬区。",
      chapterType: "正文"
    };
    const created = await request(runtime.app).post(`/api/works/${fixture.workId}/chapters`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-chapter-create-0001").send(payload).expect(201);
    const replayed = await request(runtime.app).post(`/api/works/${fixture.workId}/chapters`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-chapter-create-0001").send(payload).expect(201);
    expect(replayed.body.data).toEqual(created.body.data);

    const duplicate = await request(runtime.app).post(`/api/works/${fixture.workId}/chapters`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-chapter-create-0002").send(payload).expect(409);
    expect(duplicate.body.error).toMatchObject({
      code: "DUPLICATE_CANDIDATES",
      details: { candidates: [expect.objectContaining({ id: created.body.data.id, entityType: "chapter", title: payload.title, versionNo: 1 })] }
    });
    await request(runtime.app).post(`/api/works/${fixture.workId}/chapters`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-chapter-foreign-volume-0001")
      .send({ ...payload, volumeId: foreignVolume.id, title: "越界分卷" }).expect(400);
    await request(runtime.app).post(`/api/works/${fixture.workId}/chapters`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-chapter-foreign-anchor-0001")
      .send({ ...payload, title: "越界锚点", insertAfterChapterId: foreignChapter.id }).expect(400);
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM chapters WHERE work_id = ? AND deleted_at IS NULL", fixture.workId)).toEqual({ count: 1 });
    expect(runtime.database.get(
      "SELECT version_no, created_by_user_id FROM chapter_versions WHERE chapter_id = ?",
      created.body.data.id
    )).toEqual({ version_no: 1, created_by_user_id: fixture.user.userId });
    expect(runtime.database.get("SELECT action, user_id FROM audit_logs WHERE entity_id = ? AND action = 'chapter.created'", created.body.data.id))
      .toEqual({ action: "chapter.created", user_id: fixture.user.userId });
  });

  it("幂等创建章节正文计划和撤销计划且保留真实操作者", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const fixture = await registerFixture(runtime, "idempotent_chapter_write_plan");
    const authorization = `Bearer ${fixture.apiKey}`;
    const volume = runWithRequestActor(fixture.user, () => runtime.store.createVolume(fixture.workId, { title: "第一卷" }));
    const chapter = runWithRequestActor(fixture.user, () => runtime.store.createChapter(fixture.workId, {
      volumeId: String(volume.id),
      title: "第一章",
      content: "旧正文"
    }));
    const payload = {
      chapterId: chapter.id,
      content: "由 ChatGPT 插件准备的新正文",
      expectedVersionNo: chapter.versionNo,
      summary: "更新第一章正文",
      changeNote: "调整开场"
    };
    const created = await request(runtime.app)
      .post(`/api/works/${fixture.workId}/ai/write-plans/chapter-content`)
      .set("Authorization", authorization)
      .set("Idempotency-Key", "mcp-chapter-plan-create-0001")
      .send(payload)
      .expect(201);
    const replayed = await request(runtime.app)
      .post(`/api/works/${fixture.workId}/ai/write-plans/chapter-content`)
      .set("Authorization", authorization)
      .set("Idempotency-Key", "mcp-chapter-plan-create-0001")
      .send(payload)
      .expect(201);
    expect(replayed.headers["idempotency-replayed"]).toBe("true");
    expect(replayed.body.data.id).toBe(created.body.data.id);
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM ai_write_plans WHERE work_id = ?", fixture.workId)).toEqual({ count: 1 });

    await request(runtime.app)
      .post(`/api/works/${fixture.workId}/ai/write-plans/${created.body.data.id}/confirm`)
      .set("Authorization", authorization)
      .expect(200);
    expect(runtime.store.getChapter(String(chapter.id))).toMatchObject({ content: payload.content, versionNo: Number(chapter.versionNo) + 1 });
    expect(runtime.database.get(
      "SELECT created_by_user_id FROM chapter_versions WHERE chapter_id = ? AND version_no = ?",
      String(chapter.id),
      Number(chapter.versionNo) + 1
    )).toEqual({ created_by_user_id: fixture.user.userId });

    const undo = await request(runtime.app)
      .post(`/api/works/${fixture.workId}/ai/write-plans/${created.body.data.id}/undo`)
      .set("Authorization", authorization)
      .set("Idempotency-Key", "mcp-chapter-plan-undo-0001")
      .expect(201);
    const undoReplay = await request(runtime.app)
      .post(`/api/works/${fixture.workId}/ai/write-plans/${created.body.data.id}/undo`)
      .set("Authorization", authorization)
      .set("Idempotency-Key", "mcp-chapter-plan-undo-0001")
      .expect(201);
    expect(undoReplay.headers["idempotency-replayed"]).toBe("true");
    expect(undoReplay.body.data.id).toBe(undo.body.data.id);
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM ai_write_plans WHERE work_id = ?", fixture.workId)).toEqual({ count: 2 });
  });

  it("正文计划按 API Key 作品与模块权限隔离并安全保存 SQL 特殊字符", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const owner = await registerFixture(runtime, "chapter_plan_permission_owner");
    const collaborator = await registerFixture(runtime, "chapter_plan_permission_collaborator");
    const outsider = await registerFixture(runtime, "chapter_plan_permission_outsider");
    const ownerAuthorization = `Bearer ${owner.apiKey}`;
    const collaboratorAuthorization = `Bearer ${collaborator.apiKey}`;
    const volume = runWithRequestActor(owner.user, () => runtime.store.createVolume(owner.workId, { title: "权限卷" }));
    const chapter = runWithRequestActor(owner.user, () => runtime.store.createChapter(owner.workId, {
      volumeId: String(volume.id),
      title: "权限章",
      content: "原始正文"
    }));
    const foreignVolume = runWithRequestActor(collaborator.user, () => runtime.store.createVolume(collaborator.workId, { title: "他作卷" }));
    const foreignChapter = runWithRequestActor(collaborator.user, () => runtime.store.createChapter(collaborator.workId, {
      volumeId: String(foreignVolume.id),
      title: "他作章节",
      content: "他作正文"
    }));
    const chapterId = String(chapter.id);
    const basePayload = {
      chapterId,
      content: "'); DROP TABLE chapters; --",
      expectedVersionNo: Number(chapter.versionNo),
      summary: "验证特殊字符正文"
    };

    const invalidKey = await request(runtime.app)
      .post(`/api/works/${owner.workId}/ai/write-plans/chapter-content`)
      .set("Authorization", "Bearer scrv_invalid-key")
      .set("Idempotency-Key", "chapter-plan-invalid-key-0001")
      .send(basePayload)
      .expect(401);
    expect(invalidKey.body.error.code).toBe("API_KEY_INVALID");

    const outsiderDenied = await request(runtime.app)
      .post(`/api/works/${owner.workId}/ai/write-plans/chapter-content`)
      .set("Authorization", `Bearer ${outsider.apiKey}`)
      .set("Idempotency-Key", "chapter-plan-outsider-0001")
      .send(basePayload)
      .expect(403);
    expect(outsiderDenied.body.error.code).toBe("WORK_ACCESS_DENIED");

    const allPermissions = fullWorkModulePermissions();
    runtime.auth.addMember(owner.workId, collaborator.user.userId, {
      permissions: { ...allPermissions, prose: "read", "ai-chat": "write" }
    }, owner.user.userId);
    const proseDenied = await request(runtime.app)
      .post(`/api/works/${owner.workId}/ai/write-plans/chapter-content`)
      .set("Authorization", collaboratorAuthorization)
      .set("Idempotency-Key", "chapter-plan-prose-denied-0001")
      .send(basePayload)
      .expect(403);
    expect(proseDenied.body.error.code).toBe("WORK_MODULE_WRITE_DENIED");

    runtime.auth.updateMemberPermissions(owner.workId, collaborator.user.userId, {
      permissions: { ...allPermissions, prose: "write", "ai-chat": "read" }
    });
    const aiChatDenied = await request(runtime.app)
      .post(`/api/works/${owner.workId}/ai/write-plans/chapter-content`)
      .set("Authorization", collaboratorAuthorization)
      .set("Idempotency-Key", "chapter-plan-ai-denied-0001")
      .send(basePayload)
      .expect(403);
    expect(aiChatDenied.body.error.code).toBe("WORK_MODULE_WRITE_DENIED");

    runtime.auth.updateMemberPermissions(owner.workId, collaborator.user.userId, { permissions: allPermissions });
    const crossWork = await request(runtime.app)
      .post(`/api/works/${owner.workId}/ai/write-plans/chapter-content`)
      .set("Authorization", ownerAuthorization)
      .set("Idempotency-Key", "chapter-plan-cross-work-0001")
      .send({ ...basePayload, chapterId: foreignChapter.id })
      .expect(403);
    expect(crossWork.body.error.code).toBe("CROSS_WORK_REFERENCE");

    const prepared = await request(runtime.app)
      .post(`/api/works/${owner.workId}/ai/write-plans/chapter-content`)
      .set("Authorization", collaboratorAuthorization)
      .set("Idempotency-Key", "chapter-plan-permission-0001")
      .send(basePayload)
      .expect(201);
    expect(runtime.store.getChapter(chapterId)).toMatchObject({ content: "原始正文", versionNo: chapter.versionNo });

    runtime.auth.updateMemberPermissions(owner.workId, collaborator.user.userId, {
      permissions: { ...allPermissions, prose: "read", "ai-chat": "write" }
    });
    const invalidated = await request(runtime.app)
      .post(`/api/works/${owner.workId}/ai/write-plans/${prepared.body.data.id}/confirm`)
      .set("Authorization", collaboratorAuthorization)
      .expect(409);
    expect(invalidated.body.error.code).toBe("AI_PLAN_INVALIDATED");
    expect(runtime.store.getChapter(chapterId)).toMatchObject({ content: "原始正文", versionNo: chapter.versionNo });
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM chapter_versions WHERE chapter_id = ?", chapterId)).toEqual({ count: 1 });

    runtime.auth.updateMemberPermissions(owner.workId, collaborator.user.userId, { permissions: allPermissions });
    const retryPlan = await request(runtime.app)
      .post(`/api/works/${owner.workId}/ai/write-plans/chapter-content`)
      .set("Authorization", collaboratorAuthorization)
      .set("Idempotency-Key", "chapter-plan-permission-0002")
      .send(basePayload)
      .expect(201);
    await request(runtime.app)
      .post(`/api/works/${owner.workId}/ai/write-plans/${retryPlan.body.data.id}/confirm`)
      .set("Authorization", collaboratorAuthorization)
      .expect(200);
    expect(runtime.store.getChapter(chapterId).content).toBe(basePayload.content);
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM chapters WHERE work_id = ?", owner.workId)).toEqual({ count: 1 });
    expect(runtime.database.get(
      "SELECT created_by_user_id FROM chapter_versions WHERE chapter_id = ? AND version_no = 2",
      chapterId
    )).toEqual({ created_by_user_id: collaborator.user.userId });
    expect(runtime.database.get(
      "SELECT user_id FROM audit_logs WHERE action = 'chapter.saved' AND entity_id = ? ORDER BY rowid DESC LIMIT 1",
      chapterId
    )).toEqual({ user_id: collaborator.user.userId });
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("幂等创建章节大纲并阻止用新创建请求覆盖已有大纲", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const fixture = await registerFixture(runtime, "idempotent_chapter_outline");
    const authorization = `Bearer ${fixture.apiKey}`;
    const volume = runWithRequestActor(fixture.user, () => runtime.store.createVolume(fixture.workId, { title: "第一卷" }));
    const chapter = runWithRequestActor(fixture.user, () => runtime.store.createChapter(fixture.workId, {
      volumeId: String(volume.id),
      title: "第一章 归航"
    }));
    const chapterId = String(chapter.id);
    const payload = {
      goal: "让舰队决定穿越灰烬门。",
      conflict: "燃料不足。",
      turningPoint: "旧航标重新亮起。",
      status: "ready"
    };
    const created = await request(runtime.app).put(`/api/chapters/${chapterId}/outline`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-chapter-outline-create-0001").send(payload).expect(200);
    const replayed = await request(runtime.app).put(`/api/chapters/${chapterId}/outline`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-chapter-outline-create-0001").send(payload).expect(200);
    expect(replayed.body.data).toEqual(created.body.data);

    const duplicate = await request(runtime.app).put(`/api/chapters/${chapterId}/outline`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-chapter-outline-create-0002")
      .send({ ...payload, goal: "不得静默覆盖的新目标。" }).expect(409);
    expect(duplicate.body.error).toMatchObject({
      code: "DUPLICATE_CANDIDATES",
      details: { candidates: [expect.objectContaining({ entityType: "chapter-outline", chapterId, versionNo: 1 })] }
    });
    expect(runtime.store.getChapterOutline(chapterId)).toMatchObject({ goal: payload.goal, versionNo: 1 });
    expect(runtime.database.get(
      "SELECT version_no, created_by_user_id FROM entity_versions WHERE entity_type = 'chapter-outline' AND entity_id = ?",
      chapterId
    )).toEqual({ version_no: 1, created_by_user_id: fixture.user.userId });
    expect(runtime.database.get("SELECT action, user_id FROM audit_logs WHERE entity_id = ? AND action = 'outline.created'", chapterId))
      .toEqual({ action: "outline.created", user_id: fixture.user.userId });
  });

  it("幂等创建正式伏笔并在跨作品章节失败时完整回滚", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const fixture = await registerFixture(runtime, "idempotent_foreshadow");
    const otherFixture = await registerFixture(runtime, "idempotent_foreshadow_other");
    const authorization = `Bearer ${fixture.apiKey}`;
    const volume = runWithRequestActor(fixture.user, () => runtime.store.createVolume(fixture.workId, { title: "第一卷" }));
    const chapter = runWithRequestActor(fixture.user, () => runtime.store.createChapter(fixture.workId, {
      volumeId: String(volume.id),
      title: "第三章 灰烬门"
    }));
    const otherVolume = runWithRequestActor(otherFixture.user, () => runtime.store.createVolume(otherFixture.workId, { title: "他作分卷" }));
    const otherChapter = runWithRequestActor(otherFixture.user, () => runtime.store.createChapter(otherFixture.workId, {
      volumeId: String(otherVolume.id),
      title: "他作章节"
    }));
    const chapterId = String(chapter.id);
    const payload = {
      title: "航海钟上的陌生坐标",
      description: "停摆前浮现的坐标指向灰烬门。",
      status: "planted",
      importance: "high",
      plannedPayoffChapterId: chapterId,
      occurrences: [{ chapterId, role: "setup", note: "钟面闪过陌生坐标。", evidence: [] }]
    };
    const created = await request(runtime.app).post(`/api/works/${fixture.workId}/foreshadows`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-foreshadow-create-0001").send(payload).expect(201);
    const replayed = await request(runtime.app).post(`/api/works/${fixture.workId}/foreshadows`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-foreshadow-create-0001").send(payload).expect(201);
    expect(replayed.body.data).toEqual(created.body.data);

    const duplicate = await request(runtime.app).post(`/api/works/${fixture.workId}/foreshadows`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-foreshadow-create-0002").send(payload).expect(409);
    expect(duplicate.body.error).toMatchObject({
      code: "DUPLICATE_CANDIDATES",
      details: { candidates: [expect.objectContaining({ id: created.body.data.id, entityType: "foreshadow", title: payload.title, versionNo: 1 })] }
    });

    await request(runtime.app).post(`/api/works/${fixture.workId}/foreshadows`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-foreshadow-foreign-payoff-0001")
      .send({ ...payload, title: "越界回收章节", plannedPayoffChapterId: otherChapter.id, occurrences: [] }).expect(400);
    await request(runtime.app).post(`/api/works/${fixture.workId}/foreshadows`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-foreshadow-foreign-occurrence-0001")
      .send({ ...payload, title: "越界出现位置", plannedPayoffChapterId: null, occurrences: [{ chapterId: otherChapter.id, role: "setup" }] }).expect(400);

    expect(runtime.database.get("SELECT COUNT(*) AS count FROM foreshadows WHERE work_id = ?", fixture.workId)).toEqual({ count: 1 });
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM foreshadow_occurrences WHERE foreshadow_id = ?", created.body.data.id)).toEqual({ count: 1 });
    expect(runtime.database.get(
      "SELECT version_no, created_by_user_id FROM entity_versions WHERE entity_type = 'foreshadow' AND entity_id = ?",
      created.body.data.id
    )).toEqual({ version_no: 1, created_by_user_id: fixture.user.userId });
    expect(runtime.database.get("SELECT action, user_id FROM audit_logs WHERE entity_id = ? AND action = 'foreshadow.created'", created.body.data.id))
      .toEqual({ action: "foreshadow.created", user_id: fixture.user.userId });
  });

  it("幂等添加伏笔出现位置并校验父实体版本与章节归属", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const fixture = await registerFixture(runtime, "idempotent_foreshadow_occurrence");
    const otherFixture = await registerFixture(runtime, "idempotent_foreshadow_occurrence_other");
    const authorization = `Bearer ${fixture.apiKey}`;
    const volume = runWithRequestActor(fixture.user, () => runtime.store.createVolume(fixture.workId, { title: "第一卷" }));
    const chapter = runWithRequestActor(fixture.user, () => runtime.store.createChapter(fixture.workId, {
      volumeId: String(volume.id),
      title: "第三章 灰烬门"
    }));
    const secondChapter = runWithRequestActor(fixture.user, () => runtime.store.createChapter(fixture.workId, {
      volumeId: String(volume.id),
      title: "第四章 回声"
    }));
    const otherVolume = runWithRequestActor(otherFixture.user, () => runtime.store.createVolume(otherFixture.workId, { title: "他作分卷" }));
    const otherChapter = runWithRequestActor(otherFixture.user, () => runtime.store.createChapter(otherFixture.workId, {
      volumeId: String(otherVolume.id),
      title: "他作章节"
    }));
    const foreshadow = runWithRequestActor(fixture.user, () => runtime.store.createForeshadow(fixture.workId, {
      title: "航海钟上的陌生坐标"
    }));
    const foreshadowId = String(foreshadow.id);
    const payload = {
      chapterId: String(chapter.id),
      role: "payoff",
      note: "沈砚用坐标开启灰烬门。",
      evidence: [{ source: "chapter", quote: "钟针重新转动。" }],
      expectedVersionNo: 1
    };
    const created = await request(runtime.app).post(`/api/foreshadows/${foreshadowId}/occurrences`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-foreshadow-occurrence-create-0001").send(payload).expect(201);
    expect(created.body.data).toMatchObject({
      foreshadowId,
      workId: fixture.workId,
      chapterId: chapter.id,
      foreshadowVersionNo: 2
    });
    const replayed = await request(runtime.app).post(`/api/foreshadows/${foreshadowId}/occurrences`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-foreshadow-occurrence-create-0001").send(payload).expect(201);
    expect(replayed.body.data).toEqual(created.body.data);

    const duplicate = await request(runtime.app).post(`/api/foreshadows/${foreshadowId}/occurrences`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-foreshadow-occurrence-create-0002")
      .send({ ...payload, expectedVersionNo: 2 }).expect(409);
    expect(duplicate.body.error).toMatchObject({
      code: "DUPLICATE_CANDIDATES",
      details: { candidates: [expect.objectContaining({ id: created.body.data.id, entityType: "foreshadow-occurrence", chapterId: chapter.id, role: "payoff", versionNo: 2 })] }
    });
    await request(runtime.app).post(`/api/foreshadows/${foreshadowId}/occurrences`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-foreshadow-occurrence-foreign-0001")
      .send({ ...payload, chapterId: otherChapter.id, expectedVersionNo: 2 }).expect(400);
    await request(runtime.app).post(`/api/foreshadows/${foreshadowId}/occurrences`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-foreshadow-occurrence-stale-0001")
      .send({ ...payload, chapterId: secondChapter.id, role: "reminder", expectedVersionNo: 1 }).expect(409);

    expect(runtime.database.get("SELECT COUNT(*) AS count FROM foreshadow_occurrences WHERE foreshadow_id = ?", foreshadowId)).toEqual({ count: 1 });
    expect(runtime.database.get(
      "SELECT version_no, created_by_user_id FROM entity_versions WHERE entity_type = 'foreshadow' AND entity_id = ? ORDER BY version_no DESC LIMIT 1",
      foreshadowId
    )).toEqual({ version_no: 2, created_by_user_id: fixture.user.userId });
    expect(runtime.database.get("SELECT action, user_id FROM audit_logs WHERE entity_id = ? AND action = 'foreshadow.occurrence.created'", created.body.data.id))
      .toEqual({ action: "foreshadow.occurrence.created", user_id: fixture.user.userId });
  });

  it("幂等创建正文评论并保存正文行锚点、版本与审计", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const fixture = await registerFixture(runtime, "idempotent_chapter_comment");
    const authorization = `Bearer ${fixture.apiKey}`;
    const volume = runWithRequestActor(fixture.user, () => runtime.store.createVolume(fixture.workId, { title: "第一卷" }));
    const chapter = runWithRequestActor(fixture.user, () => runtime.store.createChapter(fixture.workId, {
      volumeId: String(volume.id),
      title: "第三章 灰烬门",
      content: "舰队抵达边缘。\n沈砚校准航标。\n航海钟突然停摆。\n钟面浮现陌生坐标。"
    }));
    const chapterId = String(chapter.id);
    const payload = {
      kind: "note",
      startLine: 3,
      endLine: 4,
      note: "这里需要提示坐标与灰烬门的联系。"
    };
    const created = await request(runtime.app).post(`/api/chapters/${chapterId}/annotations`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-chapter-comment-create-0001").send(payload).expect(201);
    expect(created.body.data).toMatchObject({
      workId: fixture.workId,
      chapterId,
      kind: "note",
      quote: "航海钟突然停摆。\n钟面浮现陌生坐标。",
      versionNo: 1,
      createdByUserId: fixture.user.userId
    });
    const replayed = await request(runtime.app).post(`/api/chapters/${chapterId}/annotations`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-chapter-comment-create-0001").send(payload).expect(201);
    expect(replayed.body.data).toEqual(created.body.data);

    const duplicate = await request(runtime.app).post(`/api/chapters/${chapterId}/annotations`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-chapter-comment-create-0002").send(payload).expect(409);
    expect(duplicate.body.error).toMatchObject({
      code: "DUPLICATE_CANDIDATES",
      details: { candidates: [expect.objectContaining({ id: created.body.data.id, entityType: "chapter-comment", chapterId, versionNo: 1 })] }
    });
    await request(runtime.app).post(`/api/chapters/${chapterId}/annotations`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-chapter-comment-invalid-lines-0001")
      .send({ ...payload, startLine: 99, endLine: 99, note: "越界评论" }).expect(400);

    expect(runtime.database.get("SELECT COUNT(*) AS count FROM chapter_annotations WHERE chapter_id = ? AND deleted_at IS NULL", chapterId)).toEqual({ count: 1 });
    expect(runtime.database.get(
      "SELECT version_no, created_by_user_id FROM chapter_annotation_versions WHERE annotation_id = ?",
      created.body.data.id
    )).toEqual({ version_no: 1, created_by_user_id: fixture.user.userId });
    expect(runtime.database.get("SELECT action, user_id FROM audit_logs WHERE entity_id = ? AND action = 'chapter.annotation.created'", created.body.data.id))
      .toEqual({ action: "chapter.annotation.created", user_id: fixture.user.userId });
  });

  it("幂等创建审核记录并记录真实操作者", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const fixture = await registerFixture(runtime, "idempotent_review_record");
    const authorization = `Bearer ${fixture.apiKey}`;
    const payload = {
      itemType: "continuity",
      dedupeKey: "chapter-26-clock-coordinate",
      severity: "high",
      title: "航海钟坐标前后不一致",
      description: "第三章与第二十六章使用了不同坐标。",
      entityRefs: [{ type: "chapter", id: "chapter-26" }],
      evidence: [{ chapterId: "chapter-26", quote: "钟针重新转动。" }],
      suggestion: "统一为第三章首次出现的坐标。"
    };
    const created = await request(runtime.app).post(`/api/works/${fixture.workId}/reviews`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-review-record-create-0001").send(payload).expect(201);
    expect(created.body.data).toMatchObject({ workId: fixture.workId, title: payload.title, status: "pending" });
    const replayed = await request(runtime.app).post(`/api/works/${fixture.workId}/reviews`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-review-record-create-0001").send(payload).expect(201);
    expect(replayed.body.data).toEqual(created.body.data);

    const duplicate = await request(runtime.app).post(`/api/works/${fixture.workId}/reviews`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-review-record-create-0002").send(payload).expect(409);
    expect(duplicate.body.error).toMatchObject({
      code: "DUPLICATE_CANDIDATES",
      details: { candidates: [expect.objectContaining({ id: created.body.data.id, entityType: "review", title: payload.title })] }
    });
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM review_items WHERE work_id = ?", fixture.workId)).toEqual({ count: 1 });
    expect(runtime.database.get("SELECT action, user_id FROM audit_logs WHERE entity_id = ? AND action = 'review.created'", created.body.data.id))
      .toEqual({ action: "review.created", user_id: fixture.user.userId });
  });

  it("幂等首次设置写作目标并阻止新创建请求覆盖已有目标", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const fixture = await registerFixture(runtime, "idempotent_writing_goal");
    const authorization = `Bearer ${fixture.apiKey}`;
    const payload = { dailyGoal: 2000, targetTotal: 120000, deadline: "2027-03-01" };
    const created = await request(runtime.app).put(`/api/works/${fixture.workId}/writing-goal`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-writing-goal-create-0001").send(payload).expect(200);
    expect(created.body.data.goal).toMatchObject(payload);
    const replayed = await request(runtime.app).put(`/api/works/${fixture.workId}/writing-goal`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-writing-goal-create-0001").send(payload).expect(200);
    expect(replayed.body.data).toEqual(created.body.data);

    const duplicate = await request(runtime.app).put(`/api/works/${fixture.workId}/writing-goal`)
      .set("Authorization", authorization).set("Idempotency-Key", "mcp-writing-goal-create-0002")
      .send({ ...payload, dailyGoal: 3000 }).expect(409);
    expect(duplicate.body.error).toMatchObject({
      code: "DUPLICATE_CANDIDATES",
      details: { candidates: [expect.objectContaining({ id: fixture.workId, entityType: "writing-goal", dailyGoal: 2000, versionNo: 1 })] }
    });
    expect(runtime.database.get("SELECT daily_goal, target_total, deadline, updated_by_user_id FROM writing_goals WHERE work_id = ?", fixture.workId)).toEqual({
      daily_goal: 2000,
      target_total: 120000,
      deadline: "2027-03-01",
      updated_by_user_id: fixture.user.userId
    });
    expect(runtime.database.get("SELECT action, user_id FROM audit_logs WHERE entity_id = ? AND action = 'work.writing_goal.updated'", fixture.workId))
      .toEqual({ action: "work.writing_goal.updated", user_id: fixture.user.userId });
  });

  it("业务操作失败时同时回滚实体和幂等记录", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const fixture = await registerFixture(runtime, "idempotent_rollback");
    const store = runtime.store as unknown as IdempotentStore;
    const input = {
      workId: fixture.workId,
      operation: "draft.create",
      idempotencyKey: "mcp-draft-rollback-0001",
      requestHash: runtime.store.hashContent("rollback-payload")
    };

    expect(() => runWithRequestActor(fixture.user, () => store.executeIdempotentMutation(input, () => {
      runtime.store.createDraft(fixture.workId, { draftType: "prose", title: "待回滚草稿", content: "不会保留。" });
      throw new Error("forced rollback");
    }))).toThrow("forced rollback");

    expect(runtime.database.get("SELECT COUNT(*) AS count FROM drafts WHERE work_id = ?", fixture.workId)).toEqual({ count: 0 });
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM api_idempotency_records WHERE work_id = ?", fixture.workId)).toEqual({ count: 0 });

    const created = runWithRequestActor(fixture.user, () => store.executeIdempotentMutation(input, () => (
      runtime.store.createDraft(fixture.workId, { draftType: "prose", title: "重试成功草稿", content: "成功保留。" })
    )));
    expect(created.replayed).toBe(false);
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM drafts WHERE work_id = ?", fixture.workId)).toEqual({ count: 1 });
  });

  it("服务重启后仍能回放首次创建结果", async () => {
    const directory = mkdtempSync(join(tmpdir(), "scriverse-mcp-idempotency-"));
    const databasePath = join(directory, "test.db");
    try {
      const firstRuntime = createTestRuntime(databasePath);
      const fixture = await registerFixture(firstRuntime, "idempotent_restart");
      const authorization = `Bearer ${fixture.apiKey}`;
      const idempotencyKey = "mcp-draft-restart-0001";
      const payload = { draftType: "prose", title: "跨重启草稿", content: "首次创建结果。" };
      const created = await request(firstRuntime.app).post(`/api/works/${fixture.workId}/drafts`)
        .set("Authorization", authorization)
        .set("Idempotency-Key", idempotencyKey)
        .send(payload)
        .expect(201);
      await firstRuntime.close();

      const restartedRuntime = createTestRuntime(databasePath);
      runtimes.push(restartedRuntime);
      const replayed = await request(restartedRuntime.app).post(`/api/works/${fixture.workId}/drafts`)
        .set("Authorization", authorization)
        .set("Idempotency-Key", idempotencyKey)
        .send(payload)
        .expect(201);

      expect(replayed.body.data).toEqual(created.body.data);
      expect(replayed.headers["idempotency-replayed"]).toBe("true");
      expect(restartedRuntime.database.get("SELECT COUNT(*) AS count FROM drafts WHERE work_id = ?", fixture.workId)).toEqual({ count: 1 });
      expect(restartedRuntime.database.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(restartedRuntime.database.all("PRAGMA foreign_key_check")).toEqual([]);
    } finally {
      await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
