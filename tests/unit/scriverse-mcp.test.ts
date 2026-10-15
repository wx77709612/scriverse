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
