import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DEFAULT_CHAPTER_ANNOTATION_NOTE_MAX_LENGTH } from "./chapter-annotation-note.js";
import { CHARACTER_GENDERS, DRAFT_SETTING_MODULES } from "./domain.js";
import { HYBRID_SEARCH_TYPES, MAXIMUM_WORK_SEARCH_QUERY_LENGTH } from "./hybrid-search.js";
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
    details?: unknown;
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
const idempotencyKey = z.string().trim().min(16).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .describe("幂等键；同一用户、作品和工具重试时必须复用该值");
const allowDuplicate = z.boolean().optional().default(false)
  .describe("仅在已经检查候选且确认要保留重名记录时设为 true");
const foreshadowOccurrenceInput = z.object({
  chapterId: identifier.describe("同一作品内的章节 ID"),
  role: z.enum(["setup", "reminder", "payoff"]).describe("出现位置的作用"),
  note: z.string().max(100_000).optional().describe("出现位置说明"),
  evidence: z.array(z.unknown()).max(100).optional().describe("结构化证据")
}).strict();

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

function creationSummary(
  entity: unknown,
  input: {
    workId: string;
    entityType: string;
    module: string;
    title?: string;
    name?: string;
    relatedEntityIds?: Record<string, unknown>;
  }
): Record<string, unknown> {
  if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
    throw new Error("Scriverse 创建响应格式无效");
  }
  const record = entity as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) {
    throw new Error("Scriverse 创建响应缺少实体 ID");
  }
  return {
    success: true,
    workId: typeof record.workId === "string" ? record.workId : input.workId,
    entityType: input.entityType,
    entityId: record.id,
    ...(input.title ? { title: input.title } : {}),
    ...(input.name ? { name: input.name } : {}),
    versionNo: typeof record.versionNo === "number" ? record.versionNo : 1,
    module: input.module,
    relatedEntityIds: Object.fromEntries(
      Object.entries(input.relatedEntityIds ?? {}).filter(([, value]) => value !== undefined && value !== null)
    )
  };
}

function selectSummaryFields(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries(fields.flatMap((field) => field in record ? [[field, record[field]]] : []));
}

function mapListItems(
  value: unknown,
  mapper: (item: unknown) => Record<string, unknown>
): unknown {
  if (Array.isArray(value)) return value.map(mapper);
  if (!value || typeof value !== "object") throw new Error("Scriverse 列表响应格式无效");
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.items)) throw new Error("Scriverse 分页列表响应缺少 items 字段");
  return {
    ...record,
    items: record.items.map(mapper)
  };
}

function summarizeList(value: unknown, fields: readonly string[]): unknown {
  return mapListItems(value, (item) => selectSummaryFields(item, fields));
}

function summarizeWritePlan(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Scriverse 正文审批计划响应格式无效");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.workId !== "string" || typeof record.status !== "string") {
    throw new Error("Scriverse 正文审批计划响应缺少必要字段");
  }
  const operations = Array.isArray(record.operations)
    ? record.operations.map((operation) => {
      const operationRecord = operation && typeof operation === "object" && !Array.isArray(operation)
        ? operation as Record<string, unknown>
        : {};
      const fields = Array.isArray(operationRecord.fields)
        ? operationRecord.fields.map((field) => selectSummaryFields(field, [
          "key",
          "label",
          "changed",
          "addedLines",
          "removedLines",
          "previewBefore",
          "previewAfter"
        ]))
        : [];
      const resultValue = operationRecord.result;
      const operationResult = resultValue && typeof resultValue === "object" && !Array.isArray(resultValue)
        ? selectSummaryFields(resultValue, ["entityId", "versionNo", "summary"])
        : null;
      return {
        ...selectSummaryFields(operationRecord, [
          "seq",
          "opType",
          "module",
          "entityType",
          "entityId",
          "targetVersionNo",
          "title"
        ]),
        fields,
        result: operationResult
      };
    })
    : [];
  return {
    ...selectSummaryFields(record, [
      "id",
      "workId",
      "kind",
      "status",
      "aiSummary",
      "operationCount",
      "undoAvailable",
      "sourcePlanId"
    ]),
    operations
  };
}

async function requestScriverse(
  fetchImpl: typeof fetch,
  config: ScriverseMcpConfig,
  path: string,
  options: {
    method?: "GET" | "POST" | "PUT" | "PATCH";
    query?: Record<string, string | number | boolean | undefined>;
    body?: Record<string, unknown>;
    idempotencyKey?: string;
    allowDuplicate?: boolean;
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
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
        ...(options.allowDuplicate ? { "X-Scriverse-Duplicate-Policy": "create" } : {})
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
    const details = payload.error?.details && typeof payload.error.details === "object" && !Array.isArray(payload.error.details)
      ? payload.error.details as Record<string, unknown>
      : {};
    throw new ScriverseMcpToolError(code, message, details);
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
    "get_work",
    {
      title: "获取 Scriverse 作品详情",
      description: "按作品 ID 或精确作品名称读取作品详情和分卷级章节统计，不返回章节正文。",
      inputSchema: z.object({
        workId: identifier.optional().describe("作品 ID；与 workTitle 二选一"),
        workTitle: z.string().trim().min(1).max(200).optional().describe("作品的精确名称；与 workId 二选一")
      }).strict().refine(
        (input) => (input.workId === undefined) !== (input.workTitle === undefined),
        { message: "workId 与 workTitle 必须且只能提供一个" }
      ),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, workTitle }) => {
      try {
        const resolvedWorkId = await resolveWorkId(fetchImpl, config, { workId, workTitle });
        const work = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(resolvedWorkId)}`,
          { query: { directory: "volumes" } }
        );
        return result("Scriverse 作品详情：", work, { work });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "list_chapters",
    {
      title: "列出 Scriverse 分卷章节",
      description: "分页列出指定分卷的章节摘要。结果不包含章节正文，需要正文时请再调用 get_chapter。",
      inputSchema: z.object({
        volumeId: identifier.describe("分卷 ID"),
        page: z.number().int().min(1).max(100_000).default(1).describe("页码"),
        limit: z.number().int().min(1).max(100).default(50).describe("每页最多返回的章节摘要数")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ volumeId, page, limit }) => {
      try {
        const chapters = await requestScriverse(
          fetchImpl,
          config,
          `/api/volumes/${encodeURIComponent(volumeId)}/chapters`,
          { query: { page, limit } }
        );
        return result("Scriverse 章节摘要：", chapters, { chapters });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "get_chapter",
    {
      title: "读取 Scriverse 章节",
      description: "按章节 ID 读取完整章节正文和版本信息。调用前可使用 get_work_directory 或 list_chapters 定位章节。",
      inputSchema: z.object({
        chapterId: identifier.describe("章节 ID")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ chapterId }) => {
      try {
        const chapter = await requestScriverse(
          fetchImpl,
          config,
          `/api/chapters/${encodeURIComponent(chapterId)}`
        );
        return result("Scriverse 章节：", chapter, { chapter });
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
        includeContent: z.boolean().default(false).describe("是否返回完整内容；默认只返回内容摘要"),
        page: z.number().int().min(1).max(100_000).optional().describe("可选页码；不传时保持旧版数组结果"),
        limit: z.number().int().min(1).max(100).optional().describe("可选每页数量；传入分页参数后返回分页结果")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, draftType, includeContent, page, limit }) => {
      try {
        const drafts = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(workId)}/drafts`,
          { query: { includeContent, draftType, page, limit } }
        );
        return result("Scriverse 想法：", drafts, { drafts });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "get_draft",
    {
      title: "读取 Scriverse 想法",
      description: "按想法 ID 读取完整内容、分类、关联模块和版本信息。",
      inputSchema: z.object({
        draftId: identifier.describe("想法 ID")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ draftId }) => {
      try {
        const draft = await requestScriverse(
          fetchImpl,
          config,
          `/api/drafts/${encodeURIComponent(draftId)}`
        );
        return result("Scriverse 想法详情：", draft, { draft });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "list_settings",
    {
      title: "列出 Scriverse 设定",
      description: "分页列出指定作品的设定摘要。结果默认不包含完整 Markdown 内容，需要完整内容时请调用 get_setting。",
      inputSchema: z.object({
        workId: identifier.describe("作品 ID"),
        page: z.number().int().min(1).max(100_000).default(1).describe("页码"),
        limit: z.number().int().min(1).max(100).default(50).describe("每页最多返回的设定摘要数")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, page, limit }) => {
      try {
        const settings = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(workId)}/settings`,
          { query: { includeContent: false, page, limit } }
        );
        return result("Scriverse 设定摘要：", settings, { settings });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "get_setting",
    {
      title: "读取 Scriverse 设定",
      description: "按设定 ID 读取完整内容、分类、状态和版本信息。",
      inputSchema: z.object({
        settingId: identifier.describe("设定 ID")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ settingId }) => {
      try {
        const setting = await requestScriverse(
          fetchImpl,
          config,
          `/api/settings/${encodeURIComponent(settingId)}`
        );
        return result("Scriverse 设定详情：", setting, { setting });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "list_characters",
    {
      title: "列出 Scriverse 角色",
      description: "分页列出指定作品的正式角色摘要，不展开角色扩展资料或种族长内容。",
      inputSchema: z.object({
        workId: identifier.describe("作品 ID"),
        page: z.number().int().min(1).max(100_000).default(1).describe("页码"),
        limit: z.number().int().min(1).max(100).default(50).describe("每页最多返回的角色摘要数")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, page, limit }) => {
      try {
        const characters = summarizeList(await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(workId)}/characters`,
          { query: { includeSections: false, includeMerged: 0, includeContent: false, page, limit } }
        ), [
          "id", "workId", "name", "gender", "age", "role", "summary", "tags", "raceId",
          "organizationIds", "versionNo", "isFavorite", "isPinned", "updatedAt"
        ]);
        return result("Scriverse 角色摘要：", characters, { characters });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "get_character",
    {
      title: "读取 Scriverse 角色",
      description: "按角色 ID 读取正式角色详情、关联种族和组织以及版本信息。",
      inputSchema: z.object({
        characterId: identifier.describe("角色 ID")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ characterId }) => {
      try {
        const character = await requestScriverse(
          fetchImpl,
          config,
          `/api/characters/${encodeURIComponent(characterId)}`
        );
        return result("Scriverse 角色详情：", character, { character });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "list_character_sections",
    {
      title: "列出 Scriverse 角色扩展资料",
      description: "分页列出指定角色的扩展资料摘要，完整 Markdown 内容需再按扩展资料 ID 读取。",
      inputSchema: z.object({
        characterId: identifier.describe("角色 ID"),
        page: z.number().int().min(1).max(100_000).default(1).describe("页码"),
        limit: z.number().int().min(1).max(100).default(50).describe("每页最多返回的扩展资料摘要数")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ characterId, page, limit }) => {
      try {
        const sections = await requestScriverse(
          fetchImpl,
          config,
          `/api/characters/${encodeURIComponent(characterId)}/sections`,
          { query: { page, limit } }
        );
        return result("Scriverse 角色扩展资料摘要：", sections, { sections });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "get_character_section",
    {
      title: "读取 Scriverse 角色扩展资料",
      description: "按扩展资料 ID 读取完整 Markdown 内容、所属角色和版本信息。",
      inputSchema: z.object({
        sectionId: identifier.describe("角色扩展资料 ID")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ sectionId }) => {
      try {
        const section = await requestScriverse(
          fetchImpl,
          config,
          `/api/character-sections/${encodeURIComponent(sectionId)}`
        );
        return result("Scriverse 角色扩展资料详情：", section, { section });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "list_races",
    {
      title: "列出 Scriverse 种族",
      description: "分页列出指定作品的正式种族摘要，不返回种族的完整 Markdown 资料。",
      inputSchema: z.object({
        workId: identifier.describe("作品 ID"),
        page: z.number().int().min(1).max(100_000).default(1).describe("页码"),
        limit: z.number().int().min(1).max(100).default(50).describe("每页最多返回的种族摘要数")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, page, limit }) => {
      try {
        const races = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(workId)}/races`,
          { query: { includeContent: false, page, limit } }
        );
        return result("Scriverse 种族摘要：", races, { races });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "get_race",
    {
      title: "读取 Scriverse 种族",
      description: "按种族 ID 读取完整种族资料、层级关联和版本信息。",
      inputSchema: z.object({
        raceId: identifier.describe("种族 ID")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ raceId }) => {
      try {
        const race = await requestScriverse(
          fetchImpl,
          config,
          `/api/races/${encodeURIComponent(raceId)}`
        );
        return result("Scriverse 种族详情：", race, { race });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "list_organizations",
    {
      title: "列出 Scriverse 组织",
      description: "分页列出指定作品的正式组织摘要，不返回组织的完整 Markdown 资料。",
      inputSchema: z.object({
        workId: identifier.describe("作品 ID"),
        page: z.number().int().min(1).max(100_000).default(1).describe("页码"),
        limit: z.number().int().min(1).max(100).default(50).describe("每页最多返回的组织摘要数")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, page, limit }) => {
      try {
        const organizations = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(workId)}/organizations`,
          { query: { includeContent: false, page, limit } }
        );
        return result("Scriverse 组织摘要：", organizations, { organizations });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "get_organization",
    {
      title: "读取 Scriverse 组织",
      description: "按组织 ID 读取完整组织资料、成员关联和版本信息。",
      inputSchema: z.object({
        organizationId: identifier.describe("组织 ID")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ organizationId }) => {
      try {
        const organization = await requestScriverse(
          fetchImpl,
          config,
          `/api/organizations/${encodeURIComponent(organizationId)}`
        );
        return result("Scriverse 组织详情：", organization, { organization });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "list_timeline_tracks",
    {
      title: "列出 Scriverse 时间轴轨道",
      description: "分页列出指定作品的时间轴轨道摘要。",
      inputSchema: z.object({
        workId: identifier.describe("作品 ID"),
        page: z.number().int().min(1).max(100_000).default(1).describe("页码"),
        limit: z.number().int().min(1).max(100).default(50).describe("每页最多返回的轨道数")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, page, limit }) => {
      try {
        const tracks = summarizeList(await requestScriverse(fetchImpl, config, `/api/works/${encodeURIComponent(workId)}/timeline-tracks`, {
          query: { page, limit }
        }), ["id", "workId", "name", "color", "sortOrder", "versionNo", "createdAt", "updatedAt"]);
        return result("Scriverse 时间轴轨道：", tracks, { tracks });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "get_timeline_track",
    {
      title: "读取 Scriverse 时间轴轨道",
      description: "按轨道 ID 读取时间轴轨道详情和版本信息。",
      inputSchema: z.object({ trackId: identifier.describe("时间轴轨道 ID") }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ trackId }) => {
      try {
        const track = await requestScriverse(fetchImpl, config, `/api/timeline-tracks/${encodeURIComponent(trackId)}`);
        return result("Scriverse 时间轴轨道详情：", track, { track });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "list_timeline_events",
    {
      title: "列出 Scriverse 时间轴事件",
      description: "分页列出指定作品的时间轴事件摘要。",
      inputSchema: z.object({
        workId: identifier.describe("作品 ID"),
        page: z.number().int().min(1).max(100_000).default(1).describe("页码"),
        limit: z.number().int().min(1).max(100).default(50).describe("每页最多返回的事件数")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, page, limit }) => {
      try {
        const events = summarizeList(await requestScriverse(fetchImpl, config, `/api/works/${encodeURIComponent(workId)}/timeline`, {
          query: { page, limit }
        }), [
          "id", "workId", "trackId", "name", "eventType", "timeLabel", "timeSort", "chapterIds",
          "participantIds", "location", "impactScope", "status", "versionNo", "createdAt", "updatedAt"
        ]);
        return result("Scriverse 时间轴事件：", events, { events });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "get_timeline_event",
    {
      title: "读取 Scriverse 时间轴事件",
      description: "按事件 ID 读取完整时间轴事件、关联轨道和参与角色以及版本信息。",
      inputSchema: z.object({ eventId: identifier.describe("时间轴事件 ID") }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ eventId }) => {
      try {
        const event = await requestScriverse(fetchImpl, config, `/api/timeline/${encodeURIComponent(eventId)}`);
        return result("Scriverse 时间轴事件详情：", event, { event });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "list_relationships",
    {
      title: "列出 Scriverse 人物关系",
      description: "分页列出指定作品的人物关系摘要，可按最低置信度过滤。",
      inputSchema: z.object({
        workId: identifier.describe("作品 ID"),
        minimumConfidence: z.number().finite().min(0).max(1).default(0).describe("最低置信度，范围 0 到 1"),
        page: z.number().int().min(1).max(100_000).default(1).describe("页码"),
        limit: z.number().int().min(1).max(100).default(50).describe("每页最多返回的关系数")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, minimumConfidence, page, limit }) => {
      try {
        const relationships = summarizeList(await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(workId)}/relationships`,
          { query: { minimumConfidence, page, limit } }
        ), [
          "id", "workId", "fromCharacterId", "toCharacterId", "label", "reverseLabel", "category",
          "direction", "strength", "confidence", "keywords", "confirmationStatus", "versionNo", "createdAt", "updatedAt"
        ]);
        return result("Scriverse 人物关系摘要：", relationships, { relationships });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "get_relationship",
    {
      title: "读取 Scriverse 人物关系",
      description: "按关系 ID 读取双向标签、人物关联、描述、置信度和版本信息。",
      inputSchema: z.object({ relationshipId: identifier.describe("人物关系 ID") }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ relationshipId }) => {
      try {
        const relationship = await requestScriverse(
          fetchImpl,
          config,
          `/api/relationships/${encodeURIComponent(relationshipId)}`
        );
        return result("Scriverse 人物关系详情：", relationship, { relationship });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "list_chapter_outlines",
    {
      title: "列出 Scriverse 章节大纲",
      description: "分页列出指定作品的章节大纲摘要，包括状态和未解决伏笔数量。",
      inputSchema: z.object({
        workId: identifier.describe("作品 ID"),
        page: z.number().int().min(1).max(100_000).default(1).describe("页码"),
        limit: z.number().int().min(1).max(100).default(50).describe("每页最多返回的章节大纲数")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, page, limit }) => {
      try {
        const outlines = summarizeList(await requestScriverse(fetchImpl, config, `/api/works/${encodeURIComponent(workId)}/outlines`, {
          query: { page, limit }
        }), [
          "chapterId", "chapterTitle", "volumeId", "volumeTitle", "goal", "status",
          "unresolvedForeshadowCount", "createdAt", "updatedAt"
        ]);
        return result("Scriverse 章节大纲摘要：", outlines, { outlines });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "get_chapter_outline",
    {
      title: "读取 Scriverse 章节大纲",
      description: "按章节 ID 读取目标、冲突、转折、备注、状态和版本信息；尚无大纲时返回 null。",
      inputSchema: z.object({ chapterId: identifier.describe("章节 ID") }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ chapterId }) => {
      try {
        const outline = await requestScriverse(fetchImpl, config, `/api/chapters/${encodeURIComponent(chapterId)}/outline`);
        return result("Scriverse 章节大纲详情：", outline, { outline });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "list_foreshadows",
    {
      title: "列出 Scriverse 伏笔",
      description: "分页列出指定作品的伏笔摘要和出现次数；完整描述与章节出现位置需调用 get_foreshadow。",
      inputSchema: z.object({
        workId: identifier.describe("作品 ID"),
        status: z.enum(["all", "unresolved", "resolved"]).default("all").describe("伏笔状态筛选"),
        currentChapterId: identifier.optional().describe("可选当前章节 ID，用于判断伏笔是否逾期"),
        page: z.number().int().min(1).max(100_000).default(1).describe("页码"),
        limit: z.number().int().min(1).max(100).default(50).describe("每页最多返回的伏笔摘要数")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, status, currentChapterId, page, limit }) => {
      try {
        const rawForeshadows = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(workId)}/foreshadows`,
          { query: { status, currentChapterId, page, limit } }
        );
        const foreshadows = mapListItems(rawForeshadows, (item) => {
          const summary = selectSummaryFields(item, [
            "id", "workId", "title", "status", "importance", "plannedPayoffChapterId",
            "unresolved", "overdue", "versionNo", "createdAt", "updatedAt"
          ]);
          const occurrences = item && typeof item === "object"
            ? (item as Record<string, unknown>).occurrences
            : undefined;
          return { ...summary, occurrenceCount: Array.isArray(occurrences) ? occurrences.length : 0 };
        });
        return result("Scriverse 伏笔摘要：", foreshadows, { foreshadows });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "get_foreshadow",
    {
      title: "读取 Scriverse 伏笔",
      description: "按伏笔 ID 读取完整描述、状态、计划回收章节、版本和全部章节出现位置。",
      inputSchema: z.object({ foreshadowId: identifier.describe("伏笔 ID") }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ foreshadowId }) => {
      try {
        const foreshadow = await requestScriverse(fetchImpl, config, `/api/foreshadows/${encodeURIComponent(foreshadowId)}`);
        return result("Scriverse 伏笔详情：", foreshadow, { foreshadow });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "get_writing_goal",
    {
      title: "读取 Scriverse 写作目标",
      description: "读取指定作品的每日目标、总字数目标、截止日期和最近更新时间，不返回完整写作趋势。",
      inputSchema: z.object({ workId: identifier.describe("作品 ID") }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId }) => {
      try {
        const progress = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(workId)}/writing-progress`
        );
        if (!progress || typeof progress !== "object") throw new Error("Scriverse 写作进度响应格式无效");
        const goal = (progress as Record<string, unknown>).goal;
        if (!goal || typeof goal !== "object") throw new Error("Scriverse 写作进度响应缺少 goal 字段");
        const writingGoal = { workId, ...(goal as Record<string, unknown>) };
        return result("Scriverse 写作目标：", writingGoal, { writingGoal });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "search_work_entities",
    {
      title: "搜索 Scriverse 作品资料",
      description: "按关键词搜索当前 API Key 在指定作品中有权读取的章节和设定库实体，可限定一种实体类型。",
      inputSchema: z.object({
        workId: identifier.describe("作品 ID"),
        query: z.string().trim().min(1).max(MAXIMUM_WORK_SEARCH_QUERY_LENGTH).describe("搜索关键词"),
        entityType: z.enum(HYBRID_SEARCH_TYPES).optional().describe("可选实体类型筛选"),
        limit: z.number().int().min(1).max(100).default(20).describe("最多返回的结果数")
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, query, entityType, limit }) => {
      try {
        const results = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(workId)}/search`,
          { query: { q: query, type: entityType, limit } }
        );
        if (!Array.isArray(results)) throw new Error("Scriverse 搜索响应格式无效");
        return result("Scriverse 搜索结果：", results, { results });
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
        content: z.string().max(200_000).describe("想法内容，支持 Markdown"),
        idempotencyKey: idempotencyKey.optional(),
        allowDuplicate
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, idempotencyKey, allowDuplicate, ...input }) => {
      try {
        const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const draft = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(workId)}/drafts`,
          { method: "POST", body, idempotencyKey, allowDuplicate }
        );
        const creation = creationSummary(draft, {
          workId,
          entityType: "draft",
          module: input.draftType === "prose" ? "prose-drafts" : "setting-drafts",
          title: input.title,
          relatedEntityIds: {
            volumeId: input.volumeId,
            settingModule: input.settingModule
          }
        });
        return result("已创建 Scriverse 想法：", creation, { draft, creation });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "create_setting",
    {
      title: "创建 Scriverse 正式设定",
      description: "把世界观内容写入作品的正式设定模块。若返回重名候选，请先决定更新已有记录，或设置 allowDuplicate 后继续新增。",
      inputSchema: z.object({
        workId: identifier.describe("作品 ID"),
        title: z.string().trim().min(1).max(200).describe("设定标题"),
        category: z.string().trim().min(1).max(100).describe("设定分类"),
        content: z.string().trim().min(1).max(200_000).describe("设定正文，支持 Markdown"),
        tags: z.array(z.string().trim().min(1).max(100)).max(50).optional().describe("设定标签"),
        status: z.enum(["draft", "pending", "confirmed", "deprecated"]).optional().describe("设定状态"),
        authorNote: z.string().max(20_000).optional().describe("作者备注"),
        idempotencyKey,
        allowDuplicate
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, idempotencyKey, allowDuplicate, ...input }) => {
      try {
        const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const setting = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(workId)}/settings`,
          { method: "POST", body, idempotencyKey, allowDuplicate }
        );
        const creation = creationSummary(setting, {
          workId,
          entityType: "setting",
          module: "settings",
          title: input.title
        });
        return result("已创建 Scriverse 正式设定：", creation, { setting, creation });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "create_character",
    {
      title: "创建 Scriverse 正式角色",
      description: "把角色写入作品的正式角色模块。名称或别名冲突时返回已有候选，不会覆盖已有角色；需要新增时请改用可区分的新名称。",
      inputSchema: z.object({
        workId: identifier.describe("作品 ID"),
        name: z.string().trim().min(1).max(200).describe("角色标准名"),
        gender: z.enum(CHARACTER_GENDERS).optional().describe("角色性别"),
        isDead: z.boolean().optional().describe("角色是否已经死亡"),
        code: z.string().trim().max(200).optional().describe("角色代号"),
        aliases: z.array(z.string().trim().min(1).max(200)).max(100).optional().describe("别名列表"),
        raceId: identifier.nullable().optional().describe("同一作品内的种族 ID"),
        organizationIds: z.array(identifier).max(100).optional().describe("同一作品内的组织 ID"),
        firstChapterId: identifier.nullable().optional().describe("同一作品内的首次登场章节 ID"),
        idempotencyKey
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, idempotencyKey, ...input }) => {
      try {
        const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const character = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(workId)}/characters`,
          { method: "POST", body, idempotencyKey }
        );
        const creation = creationSummary(character, {
          workId,
          entityType: "character",
          module: "characters",
          name: input.name,
          relatedEntityIds: {
            raceId: input.raceId,
            organizationIds: input.organizationIds,
            firstChapterId: input.firstChapterId
          }
        });
        return result("已创建 Scriverse 正式角色：", creation, { character, creation });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "create_character_section",
    {
      title: "创建 Scriverse 角色扩展资料",
      description: "为已有角色创建正式扩展资料章节，例如背景、外貌、能力、性格或历史。重名时返回候选，不会覆盖已有章节。",
      inputSchema: z.object({
        characterId: identifier.describe("角色 ID"),
        sectionType: z.enum(["overview", "appearance", "abilities", "personality", "ecology", "background", "history", "legends", "research", "notes", "custom"]).optional(),
        title: z.string().trim().min(1).max(200).describe("资料章节标题"),
        contentMarkdown: z.string().max(500_000).optional().describe("资料正文，支持 Markdown"),
        summary: z.string().max(20_000).optional().describe("资料摘要"),
        sortOrder: z.number().int().min(0).max(100_000).optional().describe("排序序号"),
        idempotencyKey,
        allowDuplicate
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ characterId, idempotencyKey, allowDuplicate, ...input }) => {
      try {
        const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const characterSection = await requestScriverse(
          fetchImpl,
          config,
          `/api/characters/${encodeURIComponent(characterId)}/sections`,
          { method: "POST", body, idempotencyKey, allowDuplicate }
        );
        const sectionRecord = characterSection && typeof characterSection === "object" && !Array.isArray(characterSection)
          ? characterSection as Record<string, unknown>
          : null;
        const creation = creationSummary(characterSection, {
          workId: typeof sectionRecord?.workId === "string" ? sectionRecord.workId : "",
          entityType: "character-section",
          module: "characters",
          title: input.title,
          relatedEntityIds: { characterId }
        });
        return result("已创建 Scriverse 角色扩展资料：", creation, { characterSection, creation });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "create_race",
    {
      title: "创建 Scriverse 正式种族",
      description: "把种族写入作品的正式种族模块。重名时返回已有候选，不会覆盖或合并记录。",
      inputSchema: z.object({
        workId: identifier.describe("作品 ID"),
        name: z.string().trim().min(1).max(200).describe("种族名称"),
        isExtinct: z.boolean().optional().describe("是否已经灭绝"),
        parentRaceId: identifier.nullable().optional().describe("同一作品内的上级种族 ID"),
        description: z.string().max(100_000).optional().describe("种族描述"),
        settingsMarkdown: z.string().max(200_000).optional().describe("种族设定资料，支持 Markdown"),
        memberIds: z.array(identifier).max(1000).optional().describe("同一作品内的角色成员 ID"),
        idempotencyKey
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, idempotencyKey, ...input }) => {
      try {
        const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const race = await requestScriverse(fetchImpl, config, `/api/works/${encodeURIComponent(workId)}/races`, {
          method: "POST",
          body,
          idempotencyKey
        });
        const creation = creationSummary(race, {
          workId,
          entityType: "race",
          module: "races",
          name: input.name,
          relatedEntityIds: { parentRaceId: input.parentRaceId, memberIds: input.memberIds }
        });
        return result("已创建 Scriverse 正式种族：", creation, { race, creation });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "create_organization",
    {
      title: "创建 Scriverse 正式组织",
      description: "把组织写入作品的正式组织模块。重名时返回已有候选，不会覆盖或合并记录。",
      inputSchema: z.object({
        workId: identifier.describe("作品 ID"),
        name: z.string().trim().min(1).max(200).describe("组织名称"),
        isDissolved: z.boolean().optional().describe("组织是否已经解散"),
        description: z.string().max(100_000).optional().describe("组织描述"),
        settingsMarkdown: z.string().max(200_000).optional().describe("组织资料，支持 Markdown"),
        memberIds: z.array(identifier).max(1000).optional().describe("同一作品内的角色成员 ID"),
        idempotencyKey
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, idempotencyKey, ...input }) => {
      try {
        const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const organization = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(workId)}/organizations`,
          { method: "POST", body, idempotencyKey }
        );
        const creation = creationSummary(organization, {
          workId,
          entityType: "organization",
          module: "organizations",
          name: input.name,
          relatedEntityIds: { memberIds: input.memberIds }
        });
        return result("已创建 Scriverse 正式组织：", creation, { organization, creation });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "create_timeline_track",
    {
      title: "创建 Scriverse 时间轴轨道",
      description: "在作品的正式时间轴模块中创建独立轨道。重名时返回已有候选，不会覆盖已有轨道。",
      inputSchema: z.object({
        workId: identifier.describe("作品 ID"),
        name: z.string().trim().min(1).max(200).describe("轨道名称"),
        description: z.string().max(20_000).optional().describe("轨道说明"),
        sortOrder: z.number().int().min(0).max(100_000).optional().describe("排序序号"),
        idempotencyKey
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, idempotencyKey, ...input }) => {
      try {
        const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const timelineTrack = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(workId)}/timeline-tracks`,
          { method: "POST", body, idempotencyKey }
        );
        const creation = creationSummary(timelineTrack, {
          workId,
          entityType: "timeline-track",
          module: "timeline",
          name: input.name
        });
        return result("已创建 Scriverse 时间轴轨道：", creation, { timelineTrack, creation });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "create_timeline_event",
    {
      title: "创建 Scriverse 时间轴事件",
      description: "把事件写入作品的正式时间轴模块。疑似重名时返回已有候选；确认仍需新增时可设置 allowDuplicate。",
      inputSchema: z.object({
        workId: identifier.describe("作品 ID"),
        name: z.string().trim().min(1).max(300).describe("事件名称"),
        trackId: identifier.nullable().optional().describe("同一作品内的时间轴轨道 ID"),
        description: z.string().max(100_000).optional().describe("事件描述"),
        eventType: z.string().trim().max(100).optional().describe("事件类型"),
        timeLabel: z.string().max(300).optional().describe("时间标签"),
        timeSort: z.number().finite().nullable().optional().describe("时间排序值"),
        chapterIds: z.array(identifier).max(500).optional().describe("同一作品内的关联章节 ID"),
        participantIds: z.array(identifier).max(500).optional().describe("同一作品内的参与角色 ID"),
        location: z.string().max(500).optional().describe("发生地点"),
        causes: z.array(z.string().trim().min(1).max(1_000)).max(100).optional().describe("事件成因"),
        impactScope: z.enum(["personal", "organization", "regional", "world", "galaxy"]).optional().describe("影响范围"),
        evidence: z.array(z.unknown()).max(100).optional().describe("结构化证据"),
        status: z.enum(["candidate", "pending", "confirmed", "deprecated"]).optional().describe("确认状态"),
        idempotencyKey,
        allowDuplicate
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, idempotencyKey, allowDuplicate, ...input }) => {
      try {
        const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const timelineEvent = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(workId)}/timeline`,
          { method: "POST", body, idempotencyKey, allowDuplicate }
        );
        const creation = creationSummary(timelineEvent, {
          workId,
          entityType: "timeline-event",
          module: "timeline",
          name: input.name,
          relatedEntityIds: {
            trackId: input.trackId,
            chapterIds: input.chapterIds,
            participantIds: input.participantIds
          }
        });
        return result("已创建 Scriverse 时间轴事件：", creation, { timelineEvent, creation });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "create_relationship",
    {
      title: "创建 Scriverse 正式人物关系",
      description: "在作品的人物关系模块中创建正式关系。相同人物、类型和方向的关系会返回已有候选，不会覆盖已有记录。",
      inputSchema: z.object({
        workId: identifier.describe("作品 ID"),
        fromCharacterId: identifier.describe("同一作品内的起点角色 ID"),
        toCharacterId: identifier.describe("同一作品内的终点角色 ID"),
        category: z.enum(["family", "social", "emotional", "conflict", "uncertain"]).describe("关系类别"),
        subtype: z.string().trim().max(100).optional().describe("关系子类型"),
        keywords: z.array(z.string().trim().min(1).max(100)).max(30).optional().describe("关系关键词"),
        directed: z.boolean().optional().describe("关系是否有方向"),
        currentStatus: z.string().max(100).optional().describe("当前状态"),
        timeRange: z.record(z.string().max(100), z.unknown()).refine((value) => Object.keys(value).length <= 50, "时间范围字段不能超过 50 项").optional(),
        confidence: z.number().min(0).max(1).optional().describe("置信度"),
        evidence: z.array(z.unknown()).max(100).optional().describe("结构化证据"),
        confirmationStatus: z.enum(["pending", "confirmed", "rejected"]).optional().describe("确认状态"),
        locked: z.boolean().optional().describe("是否锁定"),
        idempotencyKey
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, idempotencyKey, ...input }) => {
      try {
        const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const relationship = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(workId)}/relationships`,
          { method: "POST", body, idempotencyKey }
        );
        const creation = creationSummary(relationship, {
          workId,
          entityType: "relationship",
          module: "relationships",
          title: `${input.fromCharacterId} ${input.directed ? "→" : "↔"} ${input.toCharacterId}`,
          relatedEntityIds: {
            fromCharacterId: input.fromCharacterId,
            toCharacterId: input.toCharacterId
          }
        });
        return result("已创建 Scriverse 正式人物关系：", creation, { relationship, creation });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "create_volume",
    {
      title: "创建 Scriverse 正式分卷",
      description: "在作品正文模块中创建分卷。疑似同名时返回已有候选；确认仍需保留同名分卷时可设置 allowDuplicate。",
      inputSchema: z.object({
        workId: identifier.describe("作品 ID"),
        title: z.string().trim().min(1).max(200).describe("分卷标题"),
        kind: z.enum(["main", "prequel", "extra", "epilogue", "appendix"]).optional().describe("分卷类型"),
        description: z.string().max(5_000).optional().describe("分卷简介"),
        keywords: z.array(z.string().trim().min(1).max(100)).max(100).optional().describe("分卷关键词"),
        storyOrder: z.number().int().min(0).max(1_000_000).optional().describe("故事顺序"),
        idempotencyKey,
        allowDuplicate
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, idempotencyKey, allowDuplicate, ...input }) => {
      try {
        const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const volume = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(workId)}/volumes`,
          { method: "POST", body, idempotencyKey, allowDuplicate }
        );
        const creation = creationSummary(volume, {
          workId,
          entityType: "volume",
          module: "prose",
          title: input.title
        });
        return result("已创建 Scriverse 正式分卷：", creation, { volume, creation });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "create_chapter",
    {
      title: "创建 Scriverse 正式章节",
      description: "在作品正文模块中创建新章节，可写入初始正文并指定插入位置。疑似同名时返回候选；确认仍需新增时可设置 allowDuplicate。",
      inputSchema: z.object({
        workId: identifier.describe("作品 ID"),
        volumeId: identifier.describe("同一作品内的分卷 ID"),
        title: z.string().trim().min(1).max(300).describe("章节标题"),
        content: z.string().max(2_000_000).optional().describe("新章节的初始正文"),
        chapterType: z.enum(["正文", "设定", "作者的话", "其他"]).optional().describe("章节类型"),
        insertAfterChapterId: identifier.optional().describe("同一作品内的前置章节 ID"),
        insertBeforeChapterId: identifier.optional().describe("同一作品内的后置章节 ID"),
        numberTitle: z.boolean().optional().describe("是否按照作品规则自动编号"),
        idempotencyKey,
        allowDuplicate
      }).strict().refine(
        (value) => value.insertAfterChapterId === undefined || value.insertBeforeChapterId === undefined,
        { message: "不能同时指定章节前后插入位置" }
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, idempotencyKey, allowDuplicate, ...input }) => {
      try {
        const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const chapter = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(workId)}/chapters`,
          { method: "POST", body, idempotencyKey, allowDuplicate }
        );
        const creation = creationSummary(chapter, {
          workId,
          entityType: "chapter",
          module: "prose",
          title: input.title,
          relatedEntityIds: {
            volumeId: input.volumeId,
            insertAfterChapterId: input.insertAfterChapterId,
            insertBeforeChapterId: input.insertBeforeChapterId
          }
        });
        return result("已创建 Scriverse 正式章节：", creation, { chapter, creation });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "set_chapter_outline",
    {
      title: "设置 Scriverse 章节大纲",
      description: "为指定章节创建正式大纲。若章节已有大纲则返回候选，不会静默覆盖；修改已有大纲应使用带版本号的安全更新工具。",
      inputSchema: z.object({
        chapterId: identifier.describe("章节 ID"),
        goal: z.string().max(100_000).optional().describe("章节目标"),
        conflict: z.string().max(100_000).optional().describe("核心冲突"),
        turningPoint: z.string().max(100_000).optional().describe("转折点"),
        notes: z.string().max(100_000).optional().describe("大纲备注"),
        status: z.enum(["draft", "ready", "completed"]).optional().describe("大纲状态"),
        changeNote: z.string().trim().max(500).optional().describe("创建说明"),
        idempotencyKey
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ chapterId, idempotencyKey, ...input }) => {
      try {
        const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const chapterOutline = await requestScriverse(
          fetchImpl,
          config,
          `/api/chapters/${encodeURIComponent(chapterId)}/outline`,
          { method: "PUT", body, idempotencyKey }
        );
        if (!chapterOutline || typeof chapterOutline !== "object" || Array.isArray(chapterOutline)) {
          throw new Error("Scriverse 章节大纲响应格式无效");
        }
        const outlineRecord = chapterOutline as Record<string, unknown>;
        if (typeof outlineRecord.workId !== "string" || typeof outlineRecord.chapterId !== "string") {
          throw new Error("Scriverse 章节大纲响应缺少作品或章节 ID");
        }
        const creation = creationSummary({ ...outlineRecord, id: outlineRecord.chapterId }, {
          workId: outlineRecord.workId,
          entityType: "chapter-outline",
          module: "outlines",
          title: typeof outlineRecord.chapterTitle === "string" ? outlineRecord.chapterTitle : undefined,
          relatedEntityIds: {
            chapterId: outlineRecord.chapterId,
            volumeId: outlineRecord.volumeId
          }
        });
        return result("已创建 Scriverse 正式章节大纲：", creation, { chapterOutline, creation });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "create_foreshadow",
    {
      title: "创建 Scriverse 正式伏笔",
      description: "在作品的大纲与伏笔模块中创建正式伏笔，可同时关联初始章节出现位置。疑似同名时返回候选；确认仍需新增时可设置 allowDuplicate。",
      inputSchema: z.object({
        workId: identifier.describe("作品 ID"),
        title: z.string().trim().min(1).max(300).describe("伏笔标题"),
        description: z.string().max(100_000).optional().describe("伏笔说明"),
        status: z.enum(["planned", "planted", "resolved", "abandoned"]).optional().describe("伏笔状态"),
        importance: z.enum(["low", "medium", "high"]).optional().describe("重要程度"),
        plannedPayoffChapterId: identifier.nullable().optional().describe("计划回收章节 ID"),
        resolutionNote: z.string().max(100_000).optional().describe("回收说明"),
        occurrences: z.array(foreshadowOccurrenceInput).max(500).optional().describe("初始章节出现位置"),
        idempotencyKey,
        allowDuplicate
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, idempotencyKey, allowDuplicate, ...input }) => {
      try {
        const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const foreshadow = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(workId)}/foreshadows`,
          { method: "POST", body, idempotencyKey, allowDuplicate }
        );
        const foreshadowRecord = foreshadow && typeof foreshadow === "object" && !Array.isArray(foreshadow)
          ? foreshadow as Record<string, unknown>
          : {};
        const occurrenceIds = Array.isArray(foreshadowRecord.occurrences)
          ? foreshadowRecord.occurrences.flatMap((occurrence) => (
            occurrence && typeof occurrence === "object" && typeof (occurrence as Record<string, unknown>).id === "string"
              ? [(occurrence as Record<string, unknown>).id as string]
              : []
          ))
          : [];
        const creation = creationSummary(foreshadow, {
          workId,
          entityType: "foreshadow",
          module: "outlines",
          title: input.title,
          relatedEntityIds: {
            plannedPayoffChapterId: input.plannedPayoffChapterId,
            occurrenceIds: occurrenceIds.length > 0 ? occurrenceIds : undefined
          }
        });
        return result("已创建 Scriverse 正式伏笔：", creation, { foreshadow, creation });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "add_foreshadow_occurrence",
    {
      title: "添加 Scriverse 伏笔出现位置",
      description: "把已有正式伏笔关联到同一作品的章节，并用伏笔当前版本号防止并发覆盖。疑似重复位置会返回候选；确认仍需保留时可设置 allowDuplicate。",
      inputSchema: foreshadowOccurrenceInput.extend({
        foreshadowId: identifier.describe("伏笔 ID"),
        expectedVersionNo: z.number().int().positive().describe("伏笔当前版本号"),
        idempotencyKey,
        allowDuplicate
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ foreshadowId, idempotencyKey, allowDuplicate, ...input }) => {
      try {
        const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const occurrence = await requestScriverse(
          fetchImpl,
          config,
          `/api/foreshadows/${encodeURIComponent(foreshadowId)}/occurrences`,
          { method: "POST", body, idempotencyKey, allowDuplicate }
        );
        if (!occurrence || typeof occurrence !== "object" || Array.isArray(occurrence)) {
          throw new Error("Scriverse 伏笔出现位置响应格式无效");
        }
        const occurrenceRecord = occurrence as Record<string, unknown>;
        if (typeof occurrenceRecord.workId !== "string" || typeof occurrenceRecord.foreshadowVersionNo !== "number") {
          throw new Error("Scriverse 伏笔出现位置响应缺少作品或版本信息");
        }
        const creation = creationSummary({
          ...occurrenceRecord,
          versionNo: occurrenceRecord.foreshadowVersionNo
        }, {
          workId: occurrenceRecord.workId,
          entityType: "foreshadow-occurrence",
          module: "outlines",
          title: typeof occurrenceRecord.chapterTitle === "string" ? occurrenceRecord.chapterTitle : undefined,
          relatedEntityIds: {
            foreshadowId: occurrenceRecord.foreshadowId,
            chapterId: occurrenceRecord.chapterId,
            volumeId: occurrenceRecord.volumeId
          }
        });
        return result("已添加 Scriverse 伏笔出现位置：", creation, { occurrence, creation });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "create_chapter_comment",
    {
      title: "创建 Scriverse 正文评论",
      description: "在指定章节的正文行范围创建正式评论，并保存对应正文引用与稳定行锚点。疑似重复评论会返回候选；确认仍需保留时可设置 allowDuplicate。",
      inputSchema: z.object({
        chapterId: identifier.describe("章节 ID"),
        startLine: z.number().int().positive().max(100_000).describe("评论起始行（从 1 开始）"),
        endLine: z.number().int().positive().max(100_000).describe("评论结束行（从 1 开始，最多覆盖 20 行）"),
        note: z.string().trim().min(1).max(DEFAULT_CHAPTER_ANNOTATION_NOTE_MAX_LENGTH).describe("评论内容"),
        idempotencyKey,
        allowDuplicate
      }).strict().refine((value) => value.endLine >= value.startLine && value.endLine - value.startLine < 20, {
        message: "评论结束行不能早于起始行，且一次最多覆盖 20 行正文",
        path: ["endLine"]
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ chapterId, startLine, endLine, note, idempotencyKey, allowDuplicate }) => {
      try {
        const comment = await requestScriverse(
          fetchImpl,
          config,
          `/api/chapters/${encodeURIComponent(chapterId)}/annotations`,
          {
            method: "POST",
            body: { kind: "note", startLine, endLine, note },
            idempotencyKey,
            allowDuplicate
          }
        );
        if (!comment || typeof comment !== "object" || Array.isArray(comment)
          || typeof (comment as Record<string, unknown>).workId !== "string") {
          throw new Error("Scriverse 正文评论响应缺少作品信息");
        }
        const creation = creationSummary(comment, {
          workId: (comment as Record<string, unknown>).workId as string,
          entityType: "chapter-comment",
          module: "comments",
          title: startLine === endLine ? `第 ${startLine} 行评论` : `第 ${startLine}-${endLine} 行评论`,
          relatedEntityIds: { chapterId }
        });
        return result("已创建 Scriverse 正文评论：", creation, { comment, creation });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "create_review_record",
    {
      title: "创建 Scriverse 审核记录",
      description: "在作品审核模块中创建结构化审核记录，并保留相关实体引用、证据和修订建议。疑似重复记录会返回候选；确认仍需新增时可设置 allowDuplicate。",
      inputSchema: z.object({
        workId: identifier.describe("作品 ID"),
        itemType: z.string().trim().min(1).max(100).describe("审核类型"),
        dedupeKey: z.string().trim().max(300).optional().describe("业务去重标识"),
        severity: z.enum(["low", "medium", "high"]).optional().describe("严重程度"),
        title: z.string().trim().min(1).max(300).describe("审核标题"),
        description: z.string().max(100_000).optional().describe("问题说明"),
        entityRefs: z.array(z.unknown()).max(100).optional().describe("相关实体引用"),
        evidence: z.array(z.unknown()).max(100).optional().describe("审核证据"),
        suggestion: z.string().max(100_000).optional().describe("修订建议"),
        status: z.enum(["pending", "ignored", "fixing", "fixed", "exception"]).optional().describe("审核状态"),
        resolutionNote: z.string().max(20_000).optional().describe("处理说明"),
        idempotencyKey,
        allowDuplicate
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, idempotencyKey, allowDuplicate, ...input }) => {
      try {
        const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const review = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(workId)}/reviews`,
          { method: "POST", body, idempotencyKey, allowDuplicate }
        );
        const creation = creationSummary(review, {
          workId,
          entityType: "review",
          module: "reviews",
          title: input.title
        });
        return result("已创建 Scriverse 审核记录：", creation, { review, creation });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "set_writing_goal",
    {
      title: "设置 Scriverse 写作目标",
      description: "为尚未配置目标的作品首次设置每日字数、总字数和截止日期。若已有目标则返回候选，不会静默覆盖；修改已有目标应使用带版本号的安全更新工具。",
      inputSchema: z.object({
        workId: identifier.describe("作品 ID"),
        dailyGoal: z.number().int().min(0).max(1_000_000).describe("每日目标字数"),
        targetTotal: z.number().int().min(0).max(100_000_000).describe("作品目标总字数"),
        deadline: z.string().date().nullable().describe("截止日期；无截止日期时为 null"),
        idempotencyKey
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, idempotencyKey, ...input }) => {
      try {
        const progress = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(workId)}/writing-goal`,
          { method: "PUT", body: input, idempotencyKey }
        );
        if (!progress || typeof progress !== "object" || Array.isArray(progress)) {
          throw new Error("Scriverse 写作目标响应格式无效");
        }
        const goal = (progress as Record<string, unknown>).goal;
        if (!goal || typeof goal !== "object" || Array.isArray(goal)) {
          throw new Error("Scriverse 写作目标响应缺少 goal 字段");
        }
        const writingGoal = { workId, ...(goal as Record<string, unknown>) };
        const creation = creationSummary({
          id: workId,
          workId,
          versionNo: typeof (goal as Record<string, unknown>).versionNo === "number"
            ? (goal as Record<string, unknown>).versionNo
            : 1
        }, {
          workId,
          entityType: "writing-goal",
          module: "prose",
          title: "写作目标"
        });
        return result("已设置 Scriverse 写作目标：", creation, { writingGoal, creation });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "update_draft",
    {
      title: "安全更新 Scriverse 想法",
      description: "使用当前版本号更新已有想法；若用户已在其他位置修改该想法，则返回版本冲突而不会覆盖新内容。",
      inputSchema: z.object({
        draftId: identifier.describe("想法 ID"),
        draftType: z.enum(["prose", "setting"]).optional().describe("正文类或设定库类想法"),
        volumeId: identifier.nullable().optional().describe("正文类想法关联的分卷 ID"),
        settingModule: z.enum(DRAFT_SETTING_MODULES).nullable().optional().describe("设定库类想法关联的模块"),
        title: z.string().trim().min(1).max(200).optional().describe("想法标题"),
        content: z.string().max(200_000).optional().describe("想法内容，支持 Markdown"),
        changeNote: z.string().trim().max(500).optional().describe("本次修改说明"),
        expectedVersionNo: z.number().int().positive().describe("读取到的当前版本号")
      }).strict().refine((value) => [
        value.draftType,
        value.volumeId,
        value.settingModule,
        value.title,
        value.content
      ].some((field) => field !== undefined), {
        message: "至少需要修改一项想法内容"
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ draftId, ...input }) => {
      try {
        const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const draft = await requestScriverse(
          fetchImpl,
          config,
          `/api/drafts/${encodeURIComponent(draftId)}`,
          { method: "PATCH", body }
        );
        return result("已安全更新 Scriverse 想法：", draft, { draft });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "update_setting",
    {
      title: "安全更新 Scriverse 正式设定",
      description: "使用当前版本号更新设定库中的正式设定；版本不一致时返回冲突，不会覆盖用户的新修改。",
      inputSchema: z.object({
        settingId: identifier.describe("设定 ID"),
        title: z.string().trim().min(1).max(200).optional().describe("设定标题"),
        category: z.string().trim().min(1).max(100).optional().describe("设定分类"),
        content: z.string().trim().min(1).max(200_000).optional().describe("设定正文，支持 Markdown"),
        tags: z.array(z.string().trim().min(1).max(100)).max(100).optional().describe("设定标签"),
        status: z.enum(["draft", "pending", "confirmed", "deprecated"]).optional().describe("设定状态"),
        locked: z.boolean().optional().describe("是否锁定为已确认事实"),
        evidence: z.array(z.unknown()).max(100).optional().describe("结构化证据"),
        scope: z.record(z.string(), z.unknown()).optional().describe("设定适用范围"),
        authorNote: z.string().max(20_000).optional().describe("作者备注"),
        changeNote: z.string().trim().max(500).optional().describe("本次修改说明"),
        expectedVersionNo: z.number().int().positive().describe("读取到的当前版本号")
      }).strict().refine((value) => [
        value.title,
        value.category,
        value.content,
        value.tags,
        value.status,
        value.locked,
        value.evidence,
        value.scope,
        value.authorNote
      ].some((field) => field !== undefined), {
        message: "至少需要修改一项正式设定内容"
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ settingId, ...input }) => {
      try {
        const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const setting = await requestScriverse(
          fetchImpl,
          config,
          `/api/settings/${encodeURIComponent(settingId)}`,
          { method: "PATCH", body }
        );
        return result("已安全更新 Scriverse 正式设定：", setting, { setting });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "update_character",
    {
      title: "安全更新 Scriverse 正式角色",
      description: "使用当前版本号更新正式角色及其种族、组织和首次登场章节关联；版本冲突或跨作品引用会被拒绝。",
      inputSchema: z.object({
        characterId: identifier.describe("角色 ID"),
        name: z.string().trim().min(1).max(200).optional().describe("角色标准名"),
        gender: z.enum(CHARACTER_GENDERS).optional().describe("角色性别"),
        isDead: z.boolean().optional().describe("角色是否已经死亡"),
        code: z.string().trim().max(200).optional().describe("角色代号"),
        aliases: z.array(z.string().trim().min(1).max(200)).max(100).optional().describe("别名列表"),
        raceId: identifier.nullable().optional().describe("同一作品内的种族 ID"),
        organizationIds: z.array(identifier).max(100).optional().describe("同一作品内的组织 ID"),
        attributes: z.record(z.string(), z.unknown()).optional().describe("角色属性"),
        profile: z.record(z.string(), z.unknown()).optional().describe("角色档案"),
        currentState: z.record(z.string(), z.unknown()).optional().describe("角色当前状态"),
        lockedFields: z.array(z.string().trim().min(1).max(200)).max(100).optional().describe("锁定字段"),
        firstChapterId: identifier.nullable().optional().describe("同一作品内的首次登场章节 ID"),
        changeNote: z.string().trim().max(500).optional().describe("本次修改说明"),
        expectedVersionNo: z.number().int().positive().describe("读取到的当前版本号")
      }).strict().refine((value) => [
        value.name,
        value.gender,
        value.isDead,
        value.code,
        value.aliases,
        value.raceId,
        value.organizationIds,
        value.attributes,
        value.profile,
        value.currentState,
        value.lockedFields,
        value.firstChapterId
      ].some((field) => field !== undefined), {
        message: "至少需要修改一项角色内容"
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ characterId, ...input }) => {
      try {
        const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const character = await requestScriverse(
          fetchImpl,
          config,
          `/api/characters/${encodeURIComponent(characterId)}`,
          { method: "PATCH", body }
        );
        return result("已安全更新 Scriverse 正式角色：", character, { character });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "update_character_section",
    {
      title: "安全更新 Scriverse 角色扩展资料",
      description: "使用角色扩展资料自身的当前版本号更新 Markdown 章节；不会用角色主档版本替代，也不会覆盖并发修改。",
      inputSchema: z.object({
        sectionId: identifier.describe("角色扩展资料 ID"),
        sectionType: z.enum(["overview", "appearance", "abilities", "personality", "ecology", "background", "history", "legends", "research", "notes", "custom"]).optional().describe("资料类型"),
        title: z.string().trim().min(1).max(200).optional().describe("资料标题"),
        contentMarkdown: z.string().max(500_000).optional().describe("Markdown 正文"),
        summary: z.string().max(20_000).optional().describe("资料摘要"),
        sortOrder: z.number().int().min(0).max(100_000).optional().describe("排序值"),
        sourcePath: z.string().max(2_000).nullable().optional().describe("来源路径"),
        sourceHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable().optional().describe("来源哈希"),
        changeNote: z.string().trim().max(500).optional().describe("本次修改说明"),
        expectedVersionNo: z.number().int().positive().describe("扩展资料当前版本号")
      }).strict().refine((value) => [
        value.sectionType,
        value.title,
        value.contentMarkdown,
        value.summary,
        value.sortOrder,
        value.sourcePath,
        value.sourceHash
      ].some((field) => field !== undefined), {
        message: "至少需要修改一项角色扩展资料"
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ sectionId, ...input }) => {
      try {
        const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const characterSection = await requestScriverse(
          fetchImpl,
          config,
          `/api/character-sections/${encodeURIComponent(sectionId)}`,
          { method: "PATCH", body }
        );
        return result("已安全更新 Scriverse 角色扩展资料：", characterSection, { characterSection });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "update_race",
    {
      title: "安全更新 Scriverse 正式种族",
      description: "使用当前版本号更新正式种族及其层级和角色成员关联；版本冲突或跨作品引用会被拒绝。",
      inputSchema: z.object({
        raceId: identifier.describe("种族 ID"),
        name: z.string().trim().min(1).max(200).optional().describe("种族名称"),
        isExtinct: z.boolean().optional().describe("是否已经灭绝"),
        parentRaceId: identifier.nullable().optional().describe("同一作品内的上级种族 ID"),
        description: z.string().max(100_000).optional().describe("种族描述"),
        settingsMarkdown: z.string().max(200_000).optional().describe("种族设定资料，支持 Markdown"),
        memberIds: z.array(identifier).max(1000).optional().describe("同一作品内的角色成员 ID"),
        changeNote: z.string().trim().max(500).optional().describe("本次修改说明"),
        expectedVersionNo: z.number().int().positive().describe("读取到的当前版本号")
      }).strict().refine((value) => [
        value.name,
        value.isExtinct,
        value.parentRaceId,
        value.description,
        value.settingsMarkdown,
        value.memberIds
      ].some((field) => field !== undefined), {
        message: "至少需要修改一项种族内容"
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ raceId, ...input }) => {
      try {
        const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const race = await requestScriverse(
          fetchImpl,
          config,
          `/api/races/${encodeURIComponent(raceId)}`,
          { method: "PATCH", body }
        );
        return result("已安全更新 Scriverse 正式种族：", race, { race });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "update_organization",
    {
      title: "安全更新 Scriverse 正式组织",
      description: "使用当前版本号更新正式组织及其角色成员关联；版本冲突或跨作品引用会被拒绝。",
      inputSchema: z.object({
        organizationId: identifier.describe("组织 ID"),
        name: z.string().trim().min(1).max(200).optional().describe("组织名称"),
        isDissolved: z.boolean().optional().describe("是否已经解散"),
        description: z.string().max(100_000).optional().describe("组织描述"),
        settingsMarkdown: z.string().max(200_000).optional().describe("组织资料，支持 Markdown"),
        memberIds: z.array(identifier).max(1000).optional().describe("同一作品内的角色成员 ID"),
        changeNote: z.string().trim().max(500).optional().describe("本次修改说明"),
        expectedVersionNo: z.number().int().positive().describe("读取到的当前版本号")
      }).strict().refine((value) => [
        value.name,
        value.isDissolved,
        value.description,
        value.settingsMarkdown,
        value.memberIds
      ].some((field) => field !== undefined), {
        message: "至少需要修改一项组织内容"
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ organizationId, ...input }) => {
      try {
        const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const organization = await requestScriverse(
          fetchImpl,
          config,
          `/api/organizations/${encodeURIComponent(organizationId)}`,
          { method: "PATCH", body }
        );
        return result("已安全更新 Scriverse 正式组织：", organization, { organization });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "update_timeline_event",
    {
      title: "安全更新 Scriverse 时间轴事件",
      description: "使用当前版本号更新时间轴事件；轨道、章节和参与角色必须属于同一作品，版本冲突会被拒绝。",
      inputSchema: z.object({
        eventId: identifier.describe("时间轴事件 ID"),
        name: z.string().trim().min(1).max(300).optional().describe("事件名称"),
        trackId: identifier.nullable().optional().describe("同一作品内的时间轴轨道 ID"),
        description: z.string().max(100_000).optional().describe("事件描述"),
        eventType: z.string().trim().max(100).optional().describe("事件类型"),
        timeLabel: z.string().max(300).optional().describe("时间标签"),
        timeSort: z.number().finite().nullable().optional().describe("时间排序值"),
        chapterIds: z.array(identifier).max(500).optional().describe("同一作品内的关联章节 ID"),
        participantIds: z.array(identifier).max(500).optional().describe("同一作品内的参与角色 ID"),
        location: z.string().max(500).optional().describe("发生地点"),
        causes: z.array(z.string().trim().min(1).max(1_000)).max(100).optional().describe("事件成因"),
        impactScope: z.enum(["personal", "organization", "regional", "world", "galaxy"]).optional().describe("影响范围"),
        evidence: z.array(z.unknown()).max(100).optional().describe("结构化证据"),
        status: z.enum(["candidate", "pending", "confirmed", "deprecated"]).optional().describe("确认状态"),
        changeNote: z.string().trim().max(500).optional().describe("本次修改说明"),
        expectedVersionNo: z.number().int().positive().describe("读取到的当前版本号")
      }).strict().refine((value) => [
        value.name,
        value.trackId,
        value.description,
        value.eventType,
        value.timeLabel,
        value.timeSort,
        value.chapterIds,
        value.participantIds,
        value.location,
        value.causes,
        value.impactScope,
        value.evidence,
        value.status
      ].some((field) => field !== undefined), {
        message: "至少需要修改一项时间轴事件内容"
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ eventId, ...input }) => {
      try {
        const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const timelineEvent = await requestScriverse(
          fetchImpl,
          config,
          `/api/timeline/${encodeURIComponent(eventId)}`,
          { method: "PATCH", body }
        );
        return result("已安全更新 Scriverse 时间轴事件：", timelineEvent, { timelineEvent });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "update_relationship",
    {
      title: "安全更新 Scriverse 正式人物关系",
      description: "使用当前版本号更新正式人物关系；两端角色必须属于同一作品，重复关系和版本冲突会被拒绝。",
      inputSchema: z.object({
        relationshipId: identifier.describe("人物关系 ID"),
        fromCharacterId: identifier.optional().describe("同一作品内的起点角色 ID"),
        toCharacterId: identifier.optional().describe("同一作品内的终点角色 ID"),
        category: z.enum(["family", "social", "emotional", "conflict", "uncertain"]).optional().describe("关系类别"),
        subtype: z.string().trim().max(100).optional().describe("关系子类型"),
        keywords: z.array(z.string().trim().min(1).max(100)).max(30).optional().describe("关系关键词"),
        directed: z.boolean().optional().describe("关系是否有方向"),
        currentStatus: z.string().max(100).optional().describe("当前状态"),
        timeRange: z.record(z.string().max(100), z.unknown()).refine((value) => Object.keys(value).length <= 50, "时间范围字段不能超过 50 项").optional(),
        confidence: z.number().min(0).max(1).optional().describe("置信度"),
        evidence: z.array(z.unknown()).max(100).optional().describe("结构化证据"),
        confirmationStatus: z.enum(["pending", "confirmed", "rejected"]).optional().describe("确认状态"),
        locked: z.boolean().optional().describe("是否锁定"),
        changeNote: z.string().trim().max(500).optional().describe("本次修改说明"),
        expectedVersionNo: z.number().int().positive().describe("读取到的当前版本号")
      }).strict().refine((value) => [
        value.fromCharacterId,
        value.toCharacterId,
        value.category,
        value.subtype,
        value.keywords,
        value.directed,
        value.currentStatus,
        value.timeRange,
        value.confidence,
        value.evidence,
        value.confirmationStatus,
        value.locked
      ].some((field) => field !== undefined), {
        message: "至少需要修改一项人物关系内容"
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ relationshipId, ...input }) => {
      try {
        const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const relationship = await requestScriverse(
          fetchImpl,
          config,
          `/api/relationships/${encodeURIComponent(relationshipId)}`,
          { method: "PATCH", body }
        );
        return result("已安全更新 Scriverse 正式人物关系：", relationship, { relationship });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "update_chapter_outline",
    {
      title: "安全更新 Scriverse 章节大纲",
      description: "使用章节大纲自身的当前版本号更新目标、冲突、转折和备注；不会用章节版本替代，也不会覆盖并发修改。",
      inputSchema: z.object({
        chapterId: identifier.describe("章节 ID"),
        goal: z.string().max(100_000).optional().describe("章节目标"),
        conflict: z.string().max(100_000).optional().describe("章节冲突"),
        turningPoint: z.string().max(100_000).optional().describe("章节转折"),
        notes: z.string().max(100_000).optional().describe("大纲备注"),
        status: z.enum(["draft", "ready", "completed"]).optional().describe("大纲状态"),
        changeNote: z.string().trim().max(500).optional().describe("本次修改说明"),
        expectedVersionNo: z.number().int().positive().describe("章节大纲当前版本号")
      }).strict().refine((value) => [
        value.goal,
        value.conflict,
        value.turningPoint,
        value.notes,
        value.status
      ].some((field) => field !== undefined), {
        message: "至少需要修改一项章节大纲内容"
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ chapterId, ...input }) => {
      try {
        const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const chapterOutline = await requestScriverse(
          fetchImpl,
          config,
          `/api/chapters/${encodeURIComponent(chapterId)}/outline`,
          { method: "PUT", body }
        );
        return result("已安全更新 Scriverse 章节大纲：", chapterOutline, { chapterOutline });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "update_foreshadow",
    {
      title: "安全更新 Scriverse 正式伏笔",
      description: "使用当前版本号更新正式伏笔及完整出现位置列表；所有章节必须属于同一作品，版本冲突会被拒绝。",
      inputSchema: z.object({
        foreshadowId: identifier.describe("伏笔 ID"),
        title: z.string().trim().min(1).max(300).optional().describe("伏笔标题"),
        description: z.string().max(100_000).optional().describe("伏笔描述"),
        status: z.enum(["planned", "planted", "resolved", "abandoned"]).optional().describe("伏笔状态"),
        importance: z.enum(["low", "medium", "high"]).optional().describe("重要程度"),
        plannedPayoffChapterId: identifier.nullable().optional().describe("同一作品内的计划回收章节 ID"),
        resolutionNote: z.string().max(100_000).optional().describe("回收说明"),
        occurrences: z.array(z.object({
          chapterId: identifier.describe("同一作品内的章节 ID"),
          role: z.enum(["setup", "reminder", "payoff"]),
          note: z.string().max(100_000).optional(),
          evidence: z.array(z.unknown()).max(100).optional()
        }).strict()).max(500).optional().describe("替换后的完整出现位置列表"),
        changeNote: z.string().trim().max(500).optional().describe("本次修改说明"),
        expectedVersionNo: z.number().int().positive().describe("读取到的当前版本号")
      }).strict().refine((value) => [
        value.title,
        value.description,
        value.status,
        value.importance,
        value.plannedPayoffChapterId,
        value.resolutionNote,
        value.occurrences
      ].some((field) => field !== undefined), {
        message: "至少需要修改一项伏笔内容"
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ foreshadowId, ...input }) => {
      try {
        const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const foreshadow = await requestScriverse(
          fetchImpl,
          config,
          `/api/foreshadows/${encodeURIComponent(foreshadowId)}`,
          { method: "PATCH", body }
        );
        return result("已安全更新 Scriverse 正式伏笔：", foreshadow, { foreshadow });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "update_writing_goal",
    {
      title: "安全更新 Scriverse 写作目标",
      description: "使用当前版本号更新作品写作目标；版本冲突会被拒绝并保留每次目标快照。",
      inputSchema: z.object({
        workId: identifier.describe("作品 ID"),
        dailyGoal: z.number().int().min(0).max(1_000_000).describe("每日目标字数"),
        targetTotal: z.number().int().min(0).max(100_000_000).describe("目标总字数"),
        deadline: z.string().date().nullable().describe("目标截止日期"),
        expectedVersionNo: z.number().int().positive().describe("读取到的当前版本号")
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ workId, ...input }) => {
      try {
        const progress = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(workId)}/writing-goal`,
          { method: "PUT", body: input }
        );
        const progressRecord = progress && typeof progress === "object" && !Array.isArray(progress)
          ? progress as Record<string, unknown>
          : {};
        const goalRecord = progressRecord.goal && typeof progressRecord.goal === "object" && !Array.isArray(progressRecord.goal)
          ? progressRecord.goal as Record<string, unknown>
          : {};
        const writingGoal = { workId, ...goalRecord };
        return result("已安全更新 Scriverse 写作目标：", writingGoal, { writingGoal });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "prepare_chapter_write_plan",
    {
      title: "准备 Scriverse 章节正文变更",
      description: "为指定章节准备正文变更预览，不会立即覆盖正文。返回待确认的 Write Plan；用户确认后再调用 confirm_write_plan。此工具只连接 Scriverse，不会调用第三方 AI API。",
      inputSchema: z.object({
        workId: identifier.optional().describe("作品 ID；与 workTitle 二选一"),
        workTitle: z.string().trim().min(1).max(200).optional().describe("作品精确名称；与 workId 二选一"),
        chapterId: identifier.describe("同一作品内的章节 ID"),
        content: z.string().max(2_000_000).describe("准备写入的完整章节正文"),
        expectedVersionNo: z.number().int().min(1).describe("读取章节时得到的当前版本号"),
        summary: z.string().trim().min(1).max(2000).describe("本次正文变更的简要说明"),
        changeNote: z.string().trim().max(2000).optional().describe("写入章节版本历史的修改说明"),
        idempotencyKey
      }).strict().refine(
        (input) => (input.workId === undefined) !== (input.workTitle === undefined),
        { message: "workId 与 workTitle 必须且只能提供一个" }
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, workTitle, idempotencyKey: key, ...input }) => {
      try {
        const resolvedWorkId = await resolveWorkId(fetchImpl, config, { workId, workTitle });
        const plan = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(resolvedWorkId)}/ai/write-plans/chapter-content`,
          { method: "POST", body: input, idempotencyKey: key }
        );
        const writePlan = summarizeWritePlan(plan);
        return result("已准备 Scriverse 章节正文变更，等待用户确认：", writePlan, { writePlan });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "get_write_plan",
    {
      title: "读取 Scriverse 正文变更计划",
      description: "读取正文 Write Plan 的当前状态、精简差异预览和执行结果，不返回完整章节正文。",
      inputSchema: z.object({
        workId: identifier.optional().describe("作品 ID；与 workTitle 二选一"),
        workTitle: z.string().trim().min(1).max(200).optional().describe("作品精确名称；与 workId 二选一"),
        planId: identifier.describe("Write Plan ID")
      }).strict().refine(
        (input) => (input.workId === undefined) !== (input.workTitle === undefined),
        { message: "workId 与 workTitle 必须且只能提供一个" }
      ),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, workTitle, planId }) => {
      try {
        const resolvedWorkId = await resolveWorkId(fetchImpl, config, { workId, workTitle });
        const plan = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(resolvedWorkId)}/ai/write-plans/${encodeURIComponent(planId)}`
        );
        const writePlan = summarizeWritePlan(plan);
        return result("Scriverse 正文变更计划：", writePlan, { writePlan });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "confirm_write_plan",
    {
      title: "确认执行 Scriverse 正文变更计划",
      description: "确认并执行待处理的正文 Write Plan。执行前会重新检查作品权限、章节归属和版本；版本已变化时不会覆盖。",
      inputSchema: z.object({
        workId: identifier.optional().describe("作品 ID；与 workTitle 二选一"),
        workTitle: z.string().trim().min(1).max(200).optional().describe("作品精确名称；与 workId 二选一"),
        planId: identifier.describe("用户已经审阅并明确批准的 Write Plan ID")
      }).strict().refine(
        (input) => (input.workId === undefined) !== (input.workTitle === undefined),
        { message: "workId 与 workTitle 必须且只能提供一个" }
      ),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async ({ workId, workTitle, planId }) => {
      try {
        const resolvedWorkId = await resolveWorkId(fetchImpl, config, { workId, workTitle });
        const plan = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(resolvedWorkId)}/ai/write-plans/${encodeURIComponent(planId)}/confirm`,
          { method: "POST" }
        );
        const writePlan = summarizeWritePlan(plan);
        return result("已执行 Scriverse 正文变更计划：", writePlan, { writePlan });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "reject_write_plan",
    {
      title: "拒绝 Scriverse 正文变更计划",
      description: "拒绝待处理的正文 Write Plan，不会修改章节正文。",
      inputSchema: z.object({
        workId: identifier.optional().describe("作品 ID；与 workTitle 二选一"),
        workTitle: z.string().trim().min(1).max(200).optional().describe("作品精确名称；与 workId 二选一"),
        planId: identifier.describe("需要拒绝的 Write Plan ID")
      }).strict().refine(
        (input) => (input.workId === undefined) !== (input.workTitle === undefined),
        { message: "workId 与 workTitle 必须且只能提供一个" }
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ workId, workTitle, planId }) => {
      try {
        const resolvedWorkId = await resolveWorkId(fetchImpl, config, { workId, workTitle });
        const plan = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(resolvedWorkId)}/ai/write-plans/${encodeURIComponent(planId)}/reject`,
          { method: "POST" }
        );
        const writePlan = summarizeWritePlan(plan);
        return result("已拒绝 Scriverse 正文变更计划：", writePlan, { writePlan });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  server.registerTool(
    "prepare_write_plan_undo",
    {
      title: "准备撤销 Scriverse 正文变更",
      description: "为已经执行且仍可撤销的正文 Write Plan 创建撤销预览。撤销计划不会立即写入，仍需用户再次确认并调用 confirm_write_plan。",
      inputSchema: z.object({
        workId: identifier.optional().describe("作品 ID；与 workTitle 二选一"),
        workTitle: z.string().trim().min(1).max(200).optional().describe("作品精确名称；与 workId 二选一"),
        planId: identifier.describe("需要撤销的已执行 Write Plan ID"),
        idempotencyKey
      }).strict().refine(
        (input) => (input.workId === undefined) !== (input.workTitle === undefined),
        { message: "workId 与 workTitle 必须且只能提供一个" }
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ workId, workTitle, planId, idempotencyKey: key }) => {
      try {
        const resolvedWorkId = await resolveWorkId(fetchImpl, config, { workId, workTitle });
        const plan = await requestScriverse(
          fetchImpl,
          config,
          `/api/works/${encodeURIComponent(resolvedWorkId)}/ai/write-plans/${encodeURIComponent(planId)}/undo`,
          { method: "POST", idempotencyKey: key }
        );
        const writePlan = summarizeWritePlan(plan);
        return result("已准备 Scriverse 正文撤销计划，等待用户确认：", writePlan, { writePlan });
      } catch (error) {
        return errorResult(error, config.apiKey);
      }
    }
  );

  return server;
}
