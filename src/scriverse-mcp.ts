import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DRAFT_SETTING_MODULES } from "./domain.js";
import { APP_VERSION } from "./version.js";

export type ScriverseMcpConfig = {
  baseUrl: string;
  apiKey: string;
};

type ScriverseMcpDependencies = ScriverseMcpConfig & {
  fetchImpl?: typeof fetch;
};

type ApiEnvelope = {
  data?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
  };
};

class ScriverseMcpToolError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ScriverseMcpToolError";
    this.code = code;
    this.details = details;
  }
}

const identifier = z.string().trim().min(1).max(200);

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("SCRIVERSE_BASE_URL 必须是有效的 HTTP 或 HTTPS 地址");
  }
  if (!(["http:", "https:"] as string[]).includes(url.protocol)) {
    throw new Error("SCRIVERSE_BASE_URL 只支持 HTTP 或 HTTPS 地址");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("SCRIVERSE_BASE_URL 不得包含账号、密码、查询参数或片段");
  }
  return url.toString().replace(/\/$/u, "");
}

export function loadScriverseMcpConfig(environment: Record<string, string | undefined> = process.env): ScriverseMcpConfig {
  const apiKey = environment.SCRIVERSE_API_KEY?.trim();
  if (!apiKey) throw new Error("缺少 SCRIVERSE_API_KEY，请先创建 Scriverse API Key");
  if (!apiKey.startsWith("scrv_")) throw new Error("SCRIVERSE_API_KEY 格式无效，应以 scrv_ 开头");
  return {
    baseUrl: normalizeBaseUrl(environment.SCRIVERSE_BASE_URL ?? "http://127.0.0.1:13210"),
    apiKey
  };
}

function safeErrorMessage(error: unknown, apiKey: string): string {
  const message = error instanceof Error ? error.message : "Scriverse 请求失败";
  return message.replaceAll(apiKey, "[REDACTED]");
}

function errorResult(error: unknown, apiKey: string): CallToolResult {
  if (error instanceof ScriverseMcpToolError) {
    const message = safeErrorMessage(error, apiKey);
    return {
      isError: true,
      content: [{ type: "text", text: `${error.code}: ${message}` }],
      structuredContent: {
        error: {
          code: error.code,
          message,
          ...error.details
        }
      }
    };
  }
  return {
    isError: true,
    content: [{ type: "text", text: safeErrorMessage(error, apiKey) }]
  };
}

function result(label: string, value: unknown, structuredContent: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: `${label}\n${JSON.stringify(value, null, 2)}` }],
    structuredContent
  };
}

async function requestScriverse(
  fetchImpl: typeof fetch,
  config: ScriverseMcpConfig,
  path: string,
  options: {
    method?: "GET" | "POST";
    query?: Record<string, string | number | boolean | undefined>;
    body?: Record<string, unknown>;
  } = {}
): Promise<unknown> {
  let response: Response;
  try {
    const url = new URL(`${config.baseUrl}${path}`);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    response = await fetchImpl(url, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        ...(options.body ? { "Content-Type": "application/json" } : {})
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {})
    });
  } catch (error) {
    throw new Error(`无法连接 Scriverse：${safeErrorMessage(error, config.apiKey)}`);
  }

  const text = await response.text();
  let payload: ApiEnvelope = {};
  if (text) {
    try {
      payload = JSON.parse(text) as ApiEnvelope;
    } catch {
      throw new Error(`Scriverse 返回了无效 JSON（HTTP ${response.status}）`);
    }
  }
  if (!response.ok) {
    const code = typeof payload.error?.code === "string" ? payload.error.code : `HTTP_${response.status}`;
    const message = typeof payload.error?.message === "string" ? payload.error.message : "Scriverse 请求失败";
    throw new Error(`${code}: ${message}`);
  }
  if (!("data" in payload)) throw new Error("Scriverse 响应缺少 data 字段");
  return payload.data;
}

function workCandidate(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.title !== "string") return null;
  return {
    id: record.id,
    title: record.title,
    ...(typeof record.author === "string" ? { author: record.author } : {})
  };
}

async function resolveWorkId(
  fetchImpl: typeof fetch,
  config: ScriverseMcpConfig,
  reference: { workId?: string; workTitle?: string }
): Promise<string> {
  if (reference.workId) return reference.workId;
  const works = await requestScriverse(fetchImpl, config, "/api/works");
  if (!Array.isArray(works)) throw new Error("Scriverse 作品列表格式无效");
  const candidates = works.map(workCandidate).filter((work): work is Record<string, unknown> => work !== null);
  const matches = candidates.filter((work) => work.title === reference.workTitle);
  if (matches.length === 1) return String(matches[0]!.id);
  if (matches.length > 1) {
    throw new ScriverseMcpToolError(
      "WORK_TITLE_AMBIGUOUS",
      "存在多个同名作品，请使用 workId 明确选择",
      { candidates: matches }
    );
  }
  throw new ScriverseMcpToolError(
    "WORK_TITLE_NOT_FOUND",
    "没有找到完全同名且当前 API Key 可访问的作品",
    { candidates: candidates.filter((work) => String(work.title).includes(reference.workTitle ?? "")).slice(0, 10) }
  );
}

export function createScriverseMcpServer(dependencies: ScriverseMcpDependencies): McpServer {
  const config: ScriverseMcpConfig = {
    baseUrl: normalizeBaseUrl(dependencies.baseUrl),
    apiKey: dependencies.apiKey
  };
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const server = new McpServer({ name: "scriverse-local-bridge", version: APP_VERSION });

  server.registerTool(
    "list_works",
    {
      title: "列出 Scriverse 作品",
      description: "列出当前 Scriverse API Key 有权访问的作品，用于取得后续工具所需的 workId。",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      try {
        const works = await requestScriverse(fetchImpl, config, "/api/works");
        return result("Scriverse 作品：", works, { works });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "get_work_directory",
    {
      title: "获取 Scriverse 作品目录",
      description: "按作品 ID 或精确作品名称定位作品，并分页返回分卷和章节摘要。目录不包含章节正文；需要正文时请再按章节 ID 读取。",
      inputSchema: z.object({
        workId: identifier.optional().describe("作品 ID；与 workTitle 二选一"),
        workTitle: z.string().trim().min(1).max(200).optional().describe("作品的精确名称；与 workId 二选一"),
        page: z.number().int().min(1).max(100_000).default(1).describe("章节目录页码"),
        limit: z.number().int().min(1).max(100).default(50).describe("每页最多返回的章节摘要数")
      }).strict().refine(
        (input) => (input.workId === undefined) !== (input.workTitle === undefined),
        { message: "workId 与 workTitle 必须且只能提供一个" }
      ),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, workTitle, page, limit }) => {
      try {
        const resolvedWorkId = await resolveWorkId(fetchImpl, config, { workId, workTitle });
        const directory = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(resolvedWorkId)}`,
          { query: { page, limit } }
        );
        return result("Scriverse 作品目录：", directory, { directory });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "list_drafts",
    {
      title: "列出 Scriverse 想法",
      description: "列出指定作品中的想法。想法属于未确认创作素材，不应当作正式正文或正式设定库事实。",
      inputSchema: z.object({
        workId: identifier.describe("作品 ID"),
        draftType: z.enum(["prose", "setting"]).optional().describe("正文类或设定库类想法"),
        includeContent: z.boolean().default(false).describe("是否返回完整内容；默认只返回内容摘要")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, draftType, includeContent }) => {
      try {
        const query = new URLSearchParams({ includeContent: String(includeContent) });
        if (draftType) query.set("draftType", draftType);
        const drafts = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(workId)}/drafts?${query.toString()}`
        );
        return result("Scriverse 想法：", drafts, { drafts });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "create_draft",
    {
      title: "创建 Scriverse 想法",
      description: "把新想法或生成内容保存到指定作品的想法模块。该工具只新增想法，不会修改正式正文或设定库实体。",
      inputSchema: z.object({
        workId: identifier.describe("作品 ID"),
        draftType: z.enum(["prose", "setting"]).describe("prose 表示正文类想法，setting 表示设定库类想法"),
        volumeId: identifier.nullable().optional().describe("正文类想法可关联的分卷 ID"),
        settingModule: z.enum(DRAFT_SETTING_MODULES).nullable().optional().describe("设定库类想法可关联的模块"),
        title: z.string().trim().min(1).max(200).describe("想法标题"),
        content: z.string().max(200_000).describe("想法内容，支持 Markdown")
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ workId, ...input }) => {
      try {
        const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const draft = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(workId)}/drafts`,
          { method: "POST", body }
        );
        return result("已创建 Scriverse 想法：", draft, { draft });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  return server;
}
