import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { createScriverseMcpServer, loadScriverseMcpConfig } from "../../src/scriverse-mcp.js";

type RecordedRequest = {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
};

const openClients: Client[] = [];
const openServers: Server[] = [];

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function startScriverseFixture(options: {
  works?: Array<Record<string, unknown>>;
} = {}): Promise<{ baseUrl: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const works = options.works ?? [{ id: "work-1", title: "星海余烬" }];
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readJson(request);
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        authorization: request.headers.authorization,
        body
      });
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url === "/api/works") {
        response.end(JSON.stringify({ data: works }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/works/work-1?page=2&limit=25") {
        response.end(JSON.stringify({
          data: {
            id: "work-1",
            title: "星海余烬",
            versionNo: 7,
            volumes: [{
              id: "volume-1",
              workId: "work-1",
              title: "第一卷",
              chapters: [{
                id: "chapter-26",
                workId: "work-1",
                volumeId: "volume-1",
                title: "第二十六章 归航",
                wordCount: 3200,
                versionNo: 3
              }]
            }],
            directoryPage: { page: 2, limit: 25, hasMore: true, nextPage: 3 }
          }
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/works/work-1?directory=volumes") {
        response.end(JSON.stringify({
          data: {
            id: "work-1",
            title: "星海余烬",
            author: "林川",
            description: "失落舰队寻找归途。",
            versionNo: 7,
            volumes: [{
              id: "volume-1",
              workId: "work-1",
              title: "第一卷",
              chapterCount: 51,
              chapters: []
            }]
          }
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/volumes/volume-1/chapters?page=2&limit=25") {
        response.end(JSON.stringify({
          data: {
            items: [{
              id: "chapter-26",
              workId: "work-1",
              volumeId: "volume-1",
              title: "第二十六章 归航",
              wordCount: 3200,
              versionNo: 3
            }],
            page: 2,
            limit: 25,
            hasMore: true,
            nextPage: 3
          }
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/chapters/chapter-26") {
        response.end(JSON.stringify({
          data: {
            id: "chapter-26",
            workId: "work-1",
            volumeId: "volume-1",
            title: "第二十六章 归航",
            content: "舰桥前方终于出现了熟悉的恒星。",
            wordCount: 16,
            versionNo: 3
          }
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/works/work-1/drafts?includeContent=false") {
        response.end(JSON.stringify({ data: [{ id: "draft-1", title: "雨夜开场" }] }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/works/work-1/drafts?includeContent=false&draftType=setting&page=2&limit=10") {
        response.end(JSON.stringify({
          data: {
            items: [{
              id: "draft-3",
              workId: "work-1",
              draftType: "setting",
              settingModule: "organizations",
              title: "观星会",
              contentExcerpt: "他们记录每一颗熄灭的恒星。",
              versionNo: 2
            }],
            page: 2,
            limit: 10,
            hasMore: false,
            nextPage: null
          }
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/drafts/draft-3") {
        response.end(JSON.stringify({
          data: {
            id: "draft-3",
            workId: "work-1",
            draftType: "setting",
            settingModule: "organizations",
            title: "观星会",
            content: "他们记录每一颗熄灭的恒星，并把灰烬封存在航海钟里。",
            versionNo: 2
          }
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/works/work-1/settings?includeContent=false&page=1&limit=20") {
        response.end(JSON.stringify({
          data: {
            items: [{
              id: "setting-1",
              workId: "work-1",
              title: "灰烬航标",
              category: "科技",
              contentExcerpt: "以恒星灰烬校准的远航信标。",
              versionNo: 4
            }],
            page: 1,
            limit: 20,
            hasMore: false,
            nextPage: null
          }
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/settings/setting-1") {
        response.end(JSON.stringify({
          data: {
            id: "setting-1",
            workId: "work-1",
            title: "灰烬航标",
            category: "科技",
            content: "灰烬航标以恒星灰烬校准，可在跃迁结束后重建航线。",
            versionNo: 4
          }
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/works/work-1/characters?includeSections=false&includeMerged=0&includeContent=false&page=1&limit=20") {
        response.end(JSON.stringify({
          data: {
            items: [{
              id: "character-1",
              workId: "work-1",
              name: "沈砚",
              role: "领航员",
              versionNo: 5
            }],
            page: 1,
            limit: 20,
            hasMore: false,
            nextPage: null
          }
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/characters/character-1") {
        response.end(JSON.stringify({
          data: {
            id: "character-1",
            workId: "work-1",
            name: "沈砚",
            role: "领航员",
            summary: "能记住所有星图，却认不出自己的名字。",
            raceId: "race-1",
            organizationIds: ["organization-1"],
            versionNo: 5
          }
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/characters/character-1/sections?page=1&limit=20") {
        response.end(JSON.stringify({
          data: {
            items: [{
              id: "section-1",
              workId: "work-1",
              characterId: "character-1",
              title: "失忆前经历",
              summary: "曾参与灰烬航标试验。",
              versionNo: 2
            }],
            page: 1,
            limit: 20,
            hasMore: false,
            nextPage: null
          }
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/character-sections/section-1") {
        response.end(JSON.stringify({
          data: {
            id: "section-1",
            workId: "work-1",
            characterId: "character-1",
            title: "失忆前经历",
            summary: "曾参与灰烬航标试验。",
            content: "沈砚是第一批进入灰烬航标核心舱的领航员。",
            versionNo: 2
          }
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/works/work-1/races?includeContent=false&page=1&limit=20") {
        response.end(JSON.stringify({
          data: {
            items: [{
              id: "race-1",
              workId: "work-1",
              name: "星痕人",
              summary: "皮肤会记录经过的恒星光谱。",
              parentRaceId: null,
              versionNo: 3
            }],
            page: 1,
            limit: 20,
            hasMore: false,
            nextPage: null
          }
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/races/race-1") {
        response.end(JSON.stringify({
          data: {
            id: "race-1",
            workId: "work-1",
            name: "星痕人",
            summary: "皮肤会记录经过的恒星光谱。",
            settingsMarkdown: "## 生理特征\n\n星痕会随年龄逐渐褪色。",
            parentRaceId: null,
            versionNo: 3
          }
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/works/work-1/organizations?includeContent=false&page=1&limit=20") {
        response.end(JSON.stringify({
          data: {
            items: [{
              id: "organization-1",
              workId: "work-1",
              name: "观星会",
              type: "学术组织",
              summary: "保存熄灭恒星的观测记录。",
              versionNo: 6
            }],
            page: 1,
            limit: 20,
            hasMore: false,
            nextPage: null
          }
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/organizations/organization-1") {
        response.end(JSON.stringify({
          data: {
            id: "organization-1",
            workId: "work-1",
            name: "观星会",
            type: "学术组织",
            summary: "保存熄灭恒星的观测记录。",
            settingsMarkdown: "## 章程\n\n每一次观测都必须由两名记录员交叉签名。",
            memberIds: ["character-1"],
            versionNo: 6
          }
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/works/work-1/timeline-tracks?page=1&limit=20") {
        response.end(JSON.stringify({
          data: {
            items: [{ id: "track-1", workId: "work-1", name: "舰队纪年", color: "#4f46e5", versionNo: 2 }],
            page: 1,
            limit: 20,
            hasMore: false,
            nextPage: null
          }
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/timeline-tracks/track-1") {
        response.end(JSON.stringify({
          data: { id: "track-1", workId: "work-1", name: "舰队纪年", description: "记录舰队迁徙节点。", color: "#4f46e5", versionNo: 2 }
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/works/work-1/timeline?page=1&limit=20") {
        response.end(JSON.stringify({
          data: {
            items: [{ id: "event-1", workId: "work-1", trackId: "track-1", name: "灰烬跃迁", timeLabel: "新历 17 年", versionNo: 4 }],
            page: 1,
            limit: 20,
            hasMore: false,
            nextPage: null
          }
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/timeline/event-1") {
        response.end(JSON.stringify({
          data: {
            id: "event-1",
            workId: "work-1",
            trackId: "track-1",
            name: "灰烬跃迁",
            description: "舰队首次借助灰烬航标完成长距离跃迁。",
            timeLabel: "新历 17 年",
            participantIds: ["character-1"],
            versionNo: 4
          }
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/works/work-1/relationships?minimumConfidence=0&page=1&limit=20") {
        response.end(JSON.stringify({
          data: {
            items: [{
              id: "relationship-1",
              workId: "work-1",
              fromCharacterId: "character-1",
              toCharacterId: "character-2",
              label: "导师",
              category: "alliance",
              confidence: 0.9,
              versionNo: 3
            }],
            page: 1,
            limit: 20,
            hasMore: false,
            nextPage: null
          }
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/relationships/relationship-1") {
        response.end(JSON.stringify({
          data: {
            id: "relationship-1",
            workId: "work-1",
            fromCharacterId: "character-1",
            toCharacterId: "character-2",
            label: "导师",
            reverseLabel: "学生",
            category: "alliance",
            description: "沈砚在跃迁学院指导林舟。",
            confidence: 0.9,
            versionNo: 3
          }
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/works/work-1/drafts") {
        response.statusCode = 201;
        response.end(JSON.stringify({ data: { id: "draft-2", ...(body as object) } }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "不存在" } }));
    })();
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

async function connectMcp(baseUrl: string): Promise<Client> {
  const server = createScriverseMcpServer({ baseUrl, apiKey: "scrv_test-secret" });
  const client = new Client({ name: "scriverse-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openClients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.allSettled(openClients.splice(0).map((client) => client.close()));
  await Promise.allSettled(openServers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("Scriverse MCP Bridge", () => {
  it("公开分页作品目录工具并声明严格的输入边界", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);

    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "list_works",
      "get_work_directory",
      "get_work",
      "list_chapters",
      "get_chapter",
      "list_drafts",
      "get_draft",
      "list_settings",
      "get_setting",
      "list_characters",
      "get_character",
      "list_character_sections",
      "get_character_section",
      "list_races",
      "get_race",
      "list_organizations",
      "get_organization",
      "list_timeline_tracks",
      "get_timeline_track",
      "list_timeline_events",
      "get_timeline_event",
      "list_relationships",
      "get_relationship",
      "create_draft"
    ]);
    const directoryTool = result.tools.find((tool) => tool.name === "get_work_directory");
    expect(directoryTool?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    });
    expect(directoryTool?.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        workId: { type: "string", maxLength: 200 },
        workTitle: { type: "string", maxLength: 200 },
        page: { type: "integer", minimum: 1, maximum: 100_000, default: 1 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 }
      }
    });
    expect(result.tools.find((tool) => tool.name === "create_draft")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    });
  });

  it("读取作品详情并只返回分卷级章节统计", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);

    const result = await client.callTool({
      name: "get_work",
      arguments: { workTitle: "星海余烬" }
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      work: {
        id: "work-1",
        title: "星海余烬",
        author: "林川",
        description: "失落舰队寻找归途。",
        versionNo: 7,
        volumes: [{
          id: "volume-1",
          workId: "work-1",
          title: "第一卷",
          chapterCount: 51,
          chapters: []
        }]
      }
    });
    expect(fixture.requests).toEqual([
      { method: "GET", url: "/api/works", authorization: "Bearer scrv_test-secret", body: null },
      { method: "GET", url: "/api/works/work-1?directory=volumes", authorization: "Bearer scrv_test-secret", body: null }
    ]);
  });

  it("按分卷分页读取章节摘要后再按 ID 读取完整章节", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);

    const chapters = await client.callTool({
      name: "list_chapters",
      arguments: { volumeId: "volume-1", page: 2, limit: 25 }
    });
    const chapter = await client.callTool({
      name: "get_chapter",
      arguments: { chapterId: "chapter-26" }
    });

    expect(chapters.isError).not.toBe(true);
    expect(chapters.structuredContent).toEqual({
      chapters: {
        items: [{
          id: "chapter-26",
          workId: "work-1",
          volumeId: "volume-1",
          title: "第二十六章 归航",
          wordCount: 3200,
          versionNo: 3
        }],
        page: 2,
        limit: 25,
        hasMore: true,
        nextPage: 3
      }
    });
    expect(JSON.stringify(chapters.structuredContent)).not.toContain("content");
    expect(chapter.structuredContent).toEqual({
      chapter: {
        id: "chapter-26",
        workId: "work-1",
        volumeId: "volume-1",
        title: "第二十六章 归航",
        content: "舰桥前方终于出现了熟悉的恒星。",
        wordCount: 16,
        versionNo: 3
      }
    });
    expect(fixture.requests).toEqual([
      { method: "GET", url: "/api/volumes/volume-1/chapters?page=2&limit=25", authorization: "Bearer scrv_test-secret", body: null },
      { method: "GET", url: "/api/chapters/chapter-26", authorization: "Bearer scrv_test-secret", body: null }
    ]);
  });

  it("按作品名称定位并分页返回不含正文的作品目录", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);

    const result = await client.callTool({
      name: "get_work_directory",
      arguments: { workTitle: "星海余烬", page: 2, limit: 25 }
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      directory: {
        id: "work-1",
        title: "星海余烬",
        versionNo: 7,
        volumes: [{
          id: "volume-1",
          workId: "work-1",
          title: "第一卷",
          chapters: [{
            id: "chapter-26",
            workId: "work-1",
            volumeId: "volume-1",
            title: "第二十六章 归航",
            wordCount: 3200,
            versionNo: 3
          }]
        }],
        directoryPage: { page: 2, limit: 25, hasMore: true, nextPage: 3 }
      }
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain("content");
    expect(fixture.requests).toEqual([
      { method: "GET", url: "/api/works", authorization: "Bearer scrv_test-secret", body: null },
      { method: "GET", url: "/api/works/work-1?page=2&limit=25", authorization: "Bearer scrv_test-secret", body: null }
    ]);
  });

  it("作品名称重名时返回候选而不猜测目标作品", async () => {
    const fixture = await startScriverseFixture({
      works: [
        { id: "work-1", title: "星海余烬", author: "甲" },
        { id: "work-2", title: "星海余烬", author: "乙" }
      ]
    });
    const client = await connectMcp(fixture.baseUrl);

    const result = await client.callTool({
      name: "get_work_directory",
      arguments: { workTitle: "星海余烬" }
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        code: "WORK_TITLE_AMBIGUOUS",
        message: "存在多个同名作品，请使用 workId 明确选择",
        candidates: [
          { id: "work-1", title: "星海余烬", author: "甲" },
          { id: "work-2", title: "星海余烬", author: "乙" }
        ]
      }
    });
    expect(fixture.requests).toEqual([
      { method: "GET", url: "/api/works", authorization: "Bearer scrv_test-secret", body: null }
    ]);
  });

  it("使用本地 API Key 获取作品和想法", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);

    const works = await client.callTool({ name: "list_works", arguments: {} });
    const drafts = await client.callTool({ name: "list_drafts", arguments: { workId: "work-1" } });

    expect(works.structuredContent).toEqual({ works: [{ id: "work-1", title: "星海余烬" }] });
    expect(drafts.structuredContent).toEqual({ drafts: [{ id: "draft-1", title: "雨夜开场" }] });
    expect(fixture.requests).toEqual([
      { method: "GET", url: "/api/works", authorization: "Bearer scrv_test-secret", body: null },
      { method: "GET", url: "/api/works/work-1/drafts?includeContent=false", authorization: "Bearer scrv_test-secret", body: null }
    ]);
  });

  it("分页读取想法摘要并按 ID 读取完整内容", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);

    const drafts = await client.callTool({
      name: "list_drafts",
      arguments: { workId: "work-1", draftType: "setting", page: 2, limit: 10 }
    });
    const draft = await client.callTool({
      name: "get_draft",
      arguments: { draftId: "draft-3" }
    });

    expect(drafts.structuredContent).toEqual({
      drafts: {
        items: [{
          id: "draft-3",
          workId: "work-1",
          draftType: "setting",
          settingModule: "organizations",
          title: "观星会",
          contentExcerpt: "他们记录每一颗熄灭的恒星。",
          versionNo: 2
        }],
        page: 2,
        limit: 10,
        hasMore: false,
        nextPage: null
      }
    });
    expect(JSON.stringify(drafts.structuredContent)).not.toContain("航海钟");
    expect(draft.structuredContent).toEqual({
      draft: {
        id: "draft-3",
        workId: "work-1",
        draftType: "setting",
        settingModule: "organizations",
        title: "观星会",
        content: "他们记录每一颗熄灭的恒星，并把灰烬封存在航海钟里。",
        versionNo: 2
      }
    });
    expect(fixture.requests).toEqual([
      {
        method: "GET",
        url: "/api/works/work-1/drafts?includeContent=false&draftType=setting&page=2&limit=10",
        authorization: "Bearer scrv_test-secret",
        body: null
      },
      { method: "GET", url: "/api/drafts/draft-3", authorization: "Bearer scrv_test-secret", body: null }
    ]);
  });

  it("拒绝详情工具中的未知字段且不发起 REST 请求", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);

    const invalid = await client.callTool({
      name: "get_draft",
      arguments: { draftId: "draft-3", unexpected: true }
    });

    expect(invalid.isError).toBe(true);
    expect(fixture.requests).toEqual([]);
  });

  it("分页读取设定摘要并按 ID 读取完整设定", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);

    const settings = await client.callTool({
      name: "list_settings",
      arguments: { workId: "work-1", page: 1, limit: 20 }
    });
    const setting = await client.callTool({
      name: "get_setting",
      arguments: { settingId: "setting-1" }
    });

    expect(settings.structuredContent).toEqual({
      settings: {
        items: [{
          id: "setting-1",
          workId: "work-1",
          title: "灰烬航标",
          category: "科技",
          contentExcerpt: "以恒星灰烬校准的远航信标。",
          versionNo: 4
        }],
        page: 1,
        limit: 20,
        hasMore: false,
        nextPage: null
      }
    });
    expect(JSON.stringify(settings.structuredContent)).not.toContain("跃迁结束");
    expect(setting.structuredContent).toEqual({
      setting: {
        id: "setting-1",
        workId: "work-1",
        title: "灰烬航标",
        category: "科技",
        content: "灰烬航标以恒星灰烬校准，可在跃迁结束后重建航线。",
        versionNo: 4
      }
    });
    expect(fixture.requests).toEqual([
      {
        method: "GET",
        url: "/api/works/work-1/settings?includeContent=false&page=1&limit=20",
        authorization: "Bearer scrv_test-secret",
        body: null
      },
      { method: "GET", url: "/api/settings/setting-1", authorization: "Bearer scrv_test-secret", body: null }
    ]);
  });

  it("分页读取角色摘要、角色详情和角色扩展资料", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);

    const characters = await client.callTool({
      name: "list_characters",
      arguments: { workId: "work-1", page: 1, limit: 20 }
    });
    const character = await client.callTool({
      name: "get_character",
      arguments: { characterId: "character-1" }
    });
    const sections = await client.callTool({
      name: "list_character_sections",
      arguments: { characterId: "character-1", page: 1, limit: 20 }
    });
    const section = await client.callTool({
      name: "get_character_section",
      arguments: { sectionId: "section-1" }
    });

    expect(characters.structuredContent).toEqual({
      characters: {
        items: [{ id: "character-1", workId: "work-1", name: "沈砚", role: "领航员", versionNo: 5 }],
        page: 1,
        limit: 20,
        hasMore: false,
        nextPage: null
      }
    });
    expect(character.structuredContent).toEqual({
      character: {
        id: "character-1",
        workId: "work-1",
        name: "沈砚",
        role: "领航员",
        summary: "能记住所有星图，却认不出自己的名字。",
        raceId: "race-1",
        organizationIds: ["organization-1"],
        versionNo: 5
      }
    });
    expect(sections.structuredContent).toEqual({
      sections: {
        items: [{
          id: "section-1",
          workId: "work-1",
          characterId: "character-1",
          title: "失忆前经历",
          summary: "曾参与灰烬航标试验。",
          versionNo: 2
        }],
        page: 1,
        limit: 20,
        hasMore: false,
        nextPage: null
      }
    });
    expect(section.structuredContent).toEqual({
      section: {
        id: "section-1",
        workId: "work-1",
        characterId: "character-1",
        title: "失忆前经历",
        summary: "曾参与灰烬航标试验。",
        content: "沈砚是第一批进入灰烬航标核心舱的领航员。",
        versionNo: 2
      }
    });
    expect(fixture.requests.map((request) => request.url)).toEqual([
      "/api/works/work-1/characters?includeSections=false&includeMerged=0&includeContent=false&page=1&limit=20",
      "/api/characters/character-1",
      "/api/characters/character-1/sections?page=1&limit=20",
      "/api/character-sections/section-1"
    ]);
  });

  it("分页读取种族摘要并按 ID 读取完整种族资料", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);

    const races = await client.callTool({
      name: "list_races",
      arguments: { workId: "work-1", page: 1, limit: 20 }
    });
    const race = await client.callTool({
      name: "get_race",
      arguments: { raceId: "race-1" }
    });

    expect(races.structuredContent).toEqual({
      races: {
        items: [{
          id: "race-1",
          workId: "work-1",
          name: "星痕人",
          summary: "皮肤会记录经过的恒星光谱。",
          parentRaceId: null,
          versionNo: 3
        }],
        page: 1,
        limit: 20,
        hasMore: false,
        nextPage: null
      }
    });
    expect(JSON.stringify(races.structuredContent)).not.toContain("生理特征");
    expect(race.structuredContent).toEqual({
      race: {
        id: "race-1",
        workId: "work-1",
        name: "星痕人",
        summary: "皮肤会记录经过的恒星光谱。",
        settingsMarkdown: "## 生理特征\n\n星痕会随年龄逐渐褪色。",
        parentRaceId: null,
        versionNo: 3
      }
    });
    expect(fixture.requests.map((request) => request.url)).toEqual([
      "/api/works/work-1/races?includeContent=false&page=1&limit=20",
      "/api/races/race-1"
    ]);
  });

  it("分页读取组织摘要并按 ID 读取完整组织资料", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);

    const organizations = await client.callTool({
      name: "list_organizations",
      arguments: { workId: "work-1", page: 1, limit: 20 }
    });
    const organization = await client.callTool({
      name: "get_organization",
      arguments: { organizationId: "organization-1" }
    });

    expect(organizations.structuredContent).toEqual({
      organizations: {
        items: [{
          id: "organization-1",
          workId: "work-1",
          name: "观星会",
          type: "学术组织",
          summary: "保存熄灭恒星的观测记录。",
          versionNo: 6
        }],
        page: 1,
        limit: 20,
        hasMore: false,
        nextPage: null
      }
    });
    expect(JSON.stringify(organizations.structuredContent)).not.toContain("交叉签名");
    expect(organization.structuredContent).toEqual({
      organization: {
        id: "organization-1",
        workId: "work-1",
        name: "观星会",
        type: "学术组织",
        summary: "保存熄灭恒星的观测记录。",
        settingsMarkdown: "## 章程\n\n每一次观测都必须由两名记录员交叉签名。",
        memberIds: ["character-1"],
        versionNo: 6
      }
    });
    expect(fixture.requests.map((request) => request.url)).toEqual([
      "/api/works/work-1/organizations?includeContent=false&page=1&limit=20",
      "/api/organizations/organization-1"
    ]);
  });

  it("分页读取时间轴轨道和事件并按 ID 获取详情", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);

    const tracks = await client.callTool({
      name: "list_timeline_tracks",
      arguments: { workId: "work-1", page: 1, limit: 20 }
    });
    const track = await client.callTool({ name: "get_timeline_track", arguments: { trackId: "track-1" } });
    const events = await client.callTool({
      name: "list_timeline_events",
      arguments: { workId: "work-1", page: 1, limit: 20 }
    });
    const event = await client.callTool({ name: "get_timeline_event", arguments: { eventId: "event-1" } });

    expect(tracks.structuredContent).toEqual({
      tracks: {
        items: [{ id: "track-1", workId: "work-1", name: "舰队纪年", color: "#4f46e5", versionNo: 2 }],
        page: 1,
        limit: 20,
        hasMore: false,
        nextPage: null
      }
    });
    expect(track.structuredContent).toEqual({
      track: { id: "track-1", workId: "work-1", name: "舰队纪年", description: "记录舰队迁徙节点。", color: "#4f46e5", versionNo: 2 }
    });
    expect(events.structuredContent).toEqual({
      events: {
        items: [{ id: "event-1", workId: "work-1", trackId: "track-1", name: "灰烬跃迁", timeLabel: "新历 17 年", versionNo: 4 }],
        page: 1,
        limit: 20,
        hasMore: false,
        nextPage: null
      }
    });
    expect(event.structuredContent).toEqual({
      event: {
        id: "event-1",
        workId: "work-1",
        trackId: "track-1",
        name: "灰烬跃迁",
        description: "舰队首次借助灰烬航标完成长距离跃迁。",
        timeLabel: "新历 17 年",
        participantIds: ["character-1"],
        versionNo: 4
      }
    });
    expect(fixture.requests.map((request) => request.url)).toEqual([
      "/api/works/work-1/timeline-tracks?page=1&limit=20",
      "/api/timeline-tracks/track-1",
      "/api/works/work-1/timeline?page=1&limit=20",
      "/api/timeline/event-1"
    ]);
  });

  it("分页读取人物关系摘要并按 ID 获取完整关系", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);

    const relationships = await client.callTool({
      name: "list_relationships",
      arguments: { workId: "work-1", page: 1, limit: 20 }
    });
    const relationship = await client.callTool({
      name: "get_relationship",
      arguments: { relationshipId: "relationship-1" }
    });

    expect(relationships.structuredContent).toEqual({
      relationships: {
        items: [{
          id: "relationship-1",
          workId: "work-1",
          fromCharacterId: "character-1",
          toCharacterId: "character-2",
          label: "导师",
          category: "alliance",
          confidence: 0.9,
          versionNo: 3
        }],
        page: 1,
        limit: 20,
        hasMore: false,
        nextPage: null
      }
    });
    expect(relationship.structuredContent).toEqual({
      relationship: {
        id: "relationship-1",
        workId: "work-1",
        fromCharacterId: "character-1",
        toCharacterId: "character-2",
        label: "导师",
        reverseLabel: "学生",
        category: "alliance",
        description: "沈砚在跃迁学院指导林舟。",
        confidence: 0.9,
        versionNo: 3
      }
    });
    expect(fixture.requests.map((request) => request.url)).toEqual([
      "/api/works/work-1/relationships?minimumConfidence=0&page=1&limit=20",
      "/api/relationships/relationship-1"
    ]);
  });

  it("把 GPT 生成内容保存为 Scriverse 想法", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);

    const result = await client.callTool({
      name: "create_draft",
      arguments: {
        workId: "work-1",
        draftType: "setting",
        settingModule: "characters",
        title: "失忆的领航员",
        content: "她能记住所有星图，却认不出自己的名字。"
      }
    });

    expect(result.structuredContent).toEqual({
      draft: {
        id: "draft-2",
        draftType: "setting",
        settingModule: "characters",
        title: "失忆的领航员",
        content: "她能记住所有星图，却认不出自己的名字。"
      }
    });
    expect(fixture.requests[0]).toEqual({
      method: "POST",
      url: "/api/works/work-1/drafts",
      authorization: "Bearer scrv_test-secret",
      body: {
        draftType: "setting",
        settingModule: "characters",
        title: "失忆的领航员",
        content: "她能记住所有星图，却认不出自己的名字。"
      }
    });
  });

  it("要求通过环境变量提供 Scriverse API Key", () => {
    expect(() => loadScriverseMcpConfig({})).toThrowError("SCRIVERSE_API_KEY");
    expect(loadScriverseMcpConfig({ SCRIVERSE_API_KEY: "scrv_local", SCRIVERSE_BASE_URL: "http://localhost:13210/" })).toEqual({
      apiKey: "scrv_local",
      baseUrl: "http://localhost:13210"
    });
  });
});
