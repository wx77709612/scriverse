import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";
import { runWithRequestActor } from "../../src/request-context.js";

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
