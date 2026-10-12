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

async function startScriverseFixture(): Promise<{ baseUrl: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
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
        response.end(JSON.stringify({ data: [{ id: "work-1", title: "星海余烬" }] }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/works/work-1/drafts?includeContent=false") {
        response.end(JSON.stringify({ data: [{ id: "draft-1", title: "雨夜开场" }] }));
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
  it("只公开查看作品、查看想法和创建想法三个工具", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);

    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name)).toEqual(["list_works", "list_drafts", "create_draft"]);
    expect(result.tools.find((tool) => tool.name === "create_draft")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    });
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
