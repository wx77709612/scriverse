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
  idempotencyKey?: string;
  duplicatePolicy?: string;
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
  draftDuplicate?: boolean;
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
        body,
        ...(typeof request.headers["idempotency-key"] === "string"
          ? { idempotencyKey: request.headers["idempotency-key"] }
          : {}),
        ...(typeof request.headers["x-scriverse-duplicate-policy"] === "string"
          ? { duplicatePolicy: request.headers["x-scriverse-duplicate-policy"] }
          : {})
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
      if (request.method === "PATCH" && request.url === "/api/drafts/draft-3") {
        response.end(JSON.stringify({
          data: {
            id: "draft-3",
            workId: "work-1",
            draftType: "setting",
            settingModule: "organizations",
            title: "观星会的密约",
            content: "他们记录每一颗熄灭的恒星。",
            versionNo: 3
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
      if (request.method === "PATCH" && request.url === "/api/settings/setting-1") {
        response.end(JSON.stringify({
          data: {
            id: "setting-1",
            workId: "work-1",
            title: "灰烬航标协议",
            category: "科技",
            content: "灰烬航标需要两名领航员共同校准。",
            tags: ["航行"],
            status: "confirmed",
            versionNo: 5
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
              details: { biography: "这段角色完整生平只应通过详情工具读取。" },
              profileSections: [{ id: "section-hidden", contentMarkdown: "长篇扩展资料" }],
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
      if (request.method === "PATCH" && request.url === "/api/characters/character-1") {
        response.end(JSON.stringify({
          data: {
            id: "character-1",
            workId: "work-1",
            name: "沈砚",
            code: "领航者",
            aliases: ["阿砚"],
            role: "领航员",
            raceId: "race-1",
            organizationIds: ["organization-1"],
            versionNo: 6
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
            items: [{
              id: "track-1",
              workId: "work-1",
              name: "舰队纪年",
              color: "#4f46e5",
              description: "这段轨道长描述只应通过详情工具读取。",
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
      if (request.method === "GET" && request.url === "/api/timeline-tracks/track-1") {
        response.end(JSON.stringify({
          data: { id: "track-1", workId: "work-1", name: "舰队纪年", description: "记录舰队迁徙节点。", color: "#4f46e5", versionNo: 2 }
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/works/work-1/timeline?page=1&limit=20") {
        response.end(JSON.stringify({
          data: {
            items: [{
              id: "event-1",
              workId: "work-1",
              trackId: "track-1",
              name: "灰烬跃迁",
              timeLabel: "新历 17 年",
              description: "这段事件长描述只应通过详情工具读取。",
              evidence: ["完整证据一", "完整证据二"],
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
              description: "这段关系长描述只应通过详情工具读取。",
              evidence: ["学院档案"],
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
      if (request.method === "GET" && request.url === "/api/works/work-1/outlines?page=1&limit=20") {
        response.end(JSON.stringify({
          data: {
            items: [{
              chapterId: "chapter-26",
              chapterTitle: "第二十六章 归航",
              volumeId: "volume-1",
              volumeTitle: "第一卷",
              goal: "确认故乡坐标",
              conflict: "这段完整冲突只应通过详情工具读取。",
              notes: "这段完整备注只应通过详情工具读取。",
              status: "ready",
              unresolvedForeshadowCount: 2
            }],
            page: 1,
            limit: 20,
            hasMore: false,
            nextPage: null
          }
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/chapters/chapter-26/outline") {
        response.end(JSON.stringify({
          data: {
            chapterId: "chapter-26",
            workId: "work-1",
            chapterTitle: "第二十六章 归航",
            volumeId: "volume-1",
            goal: "确认故乡坐标",
            conflict: "航标显示的恒星已经熄灭。",
            turningPoint: "沈砚认出星图中的伪造标记。",
            notes: "回收第一章的航海钟伏笔。",
            status: "ready",
            versionNo: 2
          }
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/works/work-1/foreshadows?status=unresolved&currentChapterId=chapter-26&page=1&limit=20") {
        response.end(JSON.stringify({
          data: {
            items: [{
              id: "foreshadow-1",
              workId: "work-1",
              title: "停摆的航海钟",
              description: "这段完整伏笔描述只应通过详情工具读取。",
              status: "planted",
              importance: "high",
              plannedPayoffChapterId: "chapter-26",
              unresolved: true,
              overdue: false,
              occurrences: [{ id: "occurrence-1", chapterId: "chapter-1", note: "钟针停在归航坐标。" }],
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
      if (request.method === "GET" && request.url === "/api/foreshadows/foreshadow-1") {
        response.end(JSON.stringify({
          data: {
            id: "foreshadow-1",
            workId: "work-1",
            title: "停摆的航海钟",
            description: "航海钟在每次接近伪造星图时都会停摆。",
            status: "planted",
            importance: "high",
            plannedPayoffChapterId: "chapter-26",
            resolutionNote: "",
            unresolved: true,
            overdue: false,
            occurrences: [{
              id: "occurrence-1",
              foreshadowId: "foreshadow-1",
              chapterId: "chapter-1",
              chapterTitle: "第一章 信号",
              role: "plant",
              note: "钟针停在归航坐标。",
              versionNo: 1
            }],
            versionNo: 4
          }
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/works/work-1/writing-progress") {
        response.end(JSON.stringify({
          data: {
            goal: { dailyGoal: 1500, targetTotal: 120000, deadline: "2027-03-01", updatedAt: "2026-10-15T06:00:00.000Z" },
            currentWords: 64000,
            todayWords: 1800,
            dailyCompletion: 1,
            totalCompletion: 0.5333,
            trend: []
          }
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/works/work-1/search?q=%E7%81%B0%E7%83%AC&type=character&limit=10") {
        response.end(JSON.stringify({
          data: [{
            type: "character",
            id: "character-1",
            title: "沈砚",
            subtitle: "领航员",
            snippet: "曾参与灰烬航标试验。",
            score: 0.032,
            matchKinds: ["exact"]
          }]
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/works/work-1/settings") {
        response.statusCode = 201;
        response.end(JSON.stringify({ data: { id: "setting-2", workId: "work-1", versionNo: 1, ...(body as object) } }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/works/work-1/characters") {
        response.statusCode = 201;
        response.end(JSON.stringify({ data: { id: "character-2", workId: "work-1", versionNo: 1, ...(body as object) } }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/characters/character-1/sections") {
        response.statusCode = 201;
        response.end(JSON.stringify({
          data: { id: "section-2", workId: "work-1", characterId: "character-1", versionNo: 1, ...(body as object) }
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/works/work-1/races") {
        response.statusCode = 201;
        response.end(JSON.stringify({ data: { id: "race-2", workId: "work-1", versionNo: 1, ...(body as object) } }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/works/work-1/organizations") {
        response.statusCode = 201;
        response.end(JSON.stringify({ data: { id: "organization-2", workId: "work-1", versionNo: 1, ...(body as object) } }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/works/work-1/timeline-tracks") {
        response.statusCode = 201;
        response.end(JSON.stringify({ data: { id: "track-2", workId: "work-1", versionNo: 1, ...(body as object) } }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/works/work-1/timeline") {
        response.statusCode = 201;
        response.end(JSON.stringify({ data: { id: "event-2", workId: "work-1", versionNo: 1, ...(body as object) } }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/works/work-1/relationships") {
        response.statusCode = 201;
        response.end(JSON.stringify({ data: { id: "relationship-2", workId: "work-1", versionNo: 1, ...(body as object) } }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/works/work-1/volumes") {
        response.statusCode = 201;
        response.end(JSON.stringify({ data: { id: "volume-2", workId: "work-1", versionNo: 1, ...(body as object) } }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/works/work-1/chapters") {
        response.statusCode = 201;
        response.end(JSON.stringify({ data: { id: "chapter-27", workId: "work-1", versionNo: 1, ...(body as object) } }));
        return;
      }
      if (request.method === "PUT" && request.url === "/api/chapters/chapter-26/outline") {
        response.end(JSON.stringify({
          data: {
            chapterId: "chapter-26",
            workId: "work-1",
            volumeId: "volume-1",
            chapterTitle: "第二十六章 归航",
            versionNo: 1,
            ...(body as object)
          }
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/works/work-1/foreshadows") {
        const input = body as Record<string, unknown>;
        response.end(JSON.stringify({
          data: {
            id: "foreshadow-2",
            workId: "work-1",
            versionNo: 1,
            ...input,
            occurrences: [{
              id: "occurrence-2",
              foreshadowId: "foreshadow-2",
              chapterId: "chapter-26",
              chapterTitle: "第二十六章 归航",
              volumeId: "volume-1",
              role: "setup",
              note: "钟面闪过一行陌生坐标。",
              evidence: []
            }]
          }
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/foreshadows/foreshadow-1/occurrences") {
        const { expectedVersionNo: _expectedVersionNo, ...input } = body as Record<string, unknown>;
        response.end(JSON.stringify({
          data: {
            id: "occurrence-3",
            foreshadowId: "foreshadow-1",
            workId: "work-1",
            chapterTitle: "第二十六章 归航",
            volumeId: "volume-1",
            volumeTitle: "第一卷",
            foreshadowVersionNo: 5,
            ...input
          }
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/chapters/chapter-26/annotations") {
        response.end(JSON.stringify({
          data: {
            id: "annotation-1",
            workId: "work-1",
            chapterId: "chapter-26",
            kind: "note",
            startLine: 3,
            endLine: 4,
            quote: "航海钟突然停摆。\n钟面浮现陌生坐标。",
            note: "这里需要提示坐标与灰烬门的联系。",
            status: "open",
            versionNo: 1
          }
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/works/work-1/reviews") {
        response.end(JSON.stringify({
          data: {
            id: "review-1",
            workId: "work-1",
            ...(body as object),
            status: "pending"
          }
        }));
        return;
      }
      if (request.method === "PUT" && request.url === "/api/works/work-1/writing-goal") {
        response.end(JSON.stringify({
          data: {
            goal: {
              ...(body as object),
              updatedAt: "2026-10-16T01:00:00.000Z"
            },
            currentWords: 64000,
            todayWords: 1800,
            dailyCompletion: 0.9,
            totalCompletion: 0.5333,
            trend: []
          }
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/works/work-1/drafts") {
        if (options.draftDuplicate && request.headers["x-scriverse-duplicate-policy"] !== "create") {
          response.statusCode = 409;
          response.end(JSON.stringify({
            error: {
              code: "DUPLICATE_CANDIDATES",
              message: "发现疑似重名的想法，请确认是更新已有记录还是继续新增",
              details: {
                candidates: [{ id: "draft-existing", entityType: "draft", title: "失忆的领航员", versionNo: 3 }]
              }
            }
          }));
          return;
        }
        response.statusCode = 201;
        response.end(JSON.stringify({ data: { id: "draft-2", workId: "work-1", versionNo: 1, ...(body as object) } }));
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
      "list_chapter_outlines",
      "get_chapter_outline",
      "list_foreshadows",
      "get_foreshadow",
      "get_writing_goal",
      "search_work_entities",
      "create_draft",
      "create_setting",
      "create_character",
      "create_character_section",
      "create_race",
      "create_organization",
      "create_timeline_track",
      "create_timeline_event",
      "create_relationship",
      "create_volume",
      "create_chapter",
      "set_chapter_outline",
      "create_foreshadow",
      "add_foreshadow_occurrence",
      "create_chapter_comment",
      "create_review_record",
      "set_writing_goal",
      "update_draft",
      "update_setting",
      "update_character"
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
      idempotentHint: true,
      openWorldHint: false
    });
    expect(result.tools.find((tool) => tool.name === "create_organization")?.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["workId", "name", "idempotencyKey"],
      properties: {
        workId: { type: "string", maxLength: 200 },
        name: { type: "string", maxLength: 200 },
        memberIds: { type: "array", maxItems: 1000 },
        idempotencyKey: { type: "string", minLength: 16, maxLength: 128 }
      }
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
    expect(JSON.stringify(characters.structuredContent)).not.toContain("完整生平");
    expect(JSON.stringify(characters.structuredContent)).not.toContain("长篇扩展资料");
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
    expect(JSON.stringify(tracks.structuredContent)).not.toContain("轨道长描述");
    expect(JSON.stringify(events.structuredContent)).not.toContain("事件长描述");
    expect(JSON.stringify(events.structuredContent)).not.toContain("完整证据");
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
    expect(JSON.stringify(relationships.structuredContent)).not.toContain("关系长描述");
    expect(JSON.stringify(relationships.structuredContent)).not.toContain("学院档案");
    expect(fixture.requests.map((request) => request.url)).toEqual([
      "/api/works/work-1/relationships?minimumConfidence=0&page=1&limit=20",
      "/api/relationships/relationship-1"
    ]);
  });

  it("分页读取章节大纲摘要并按章节 ID 获取详情", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);

    const outlines = await client.callTool({
      name: "list_chapter_outlines",
      arguments: { workId: "work-1", page: 1, limit: 20 }
    });
    const outline = await client.callTool({
      name: "get_chapter_outline",
      arguments: { chapterId: "chapter-26" }
    });

    expect(outlines.structuredContent).toEqual({
      outlines: {
        items: [{
          chapterId: "chapter-26",
          chapterTitle: "第二十六章 归航",
          volumeId: "volume-1",
          volumeTitle: "第一卷",
          goal: "确认故乡坐标",
          status: "ready",
          unresolvedForeshadowCount: 2
        }],
        page: 1,
        limit: 20,
        hasMore: false,
        nextPage: null
      }
    });
    expect(outline.structuredContent).toEqual({
      outline: {
        chapterId: "chapter-26",
        workId: "work-1",
        chapterTitle: "第二十六章 归航",
        volumeId: "volume-1",
        goal: "确认故乡坐标",
        conflict: "航标显示的恒星已经熄灭。",
        turningPoint: "沈砚认出星图中的伪造标记。",
        notes: "回收第一章的航海钟伏笔。",
        status: "ready",
        versionNo: 2
      }
    });
    expect(JSON.stringify(outlines.structuredContent)).not.toContain("完整冲突");
    expect(JSON.stringify(outlines.structuredContent)).not.toContain("完整备注");
    expect(fixture.requests.map((request) => request.url)).toEqual([
      "/api/works/work-1/outlines?page=1&limit=20",
      "/api/chapters/chapter-26/outline"
    ]);
  });

  it("分页读取伏笔摘要并在详情中返回章节出现位置", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);

    const foreshadows = await client.callTool({
      name: "list_foreshadows",
      arguments: {
        workId: "work-1",
        status: "unresolved",
        currentChapterId: "chapter-26",
        page: 1,
        limit: 20
      }
    });
    const foreshadow = await client.callTool({
      name: "get_foreshadow",
      arguments: { foreshadowId: "foreshadow-1" }
    });

    expect(foreshadows.structuredContent).toEqual({
      foreshadows: {
        items: [{
          id: "foreshadow-1",
          workId: "work-1",
          title: "停摆的航海钟",
          status: "planted",
          importance: "high",
          plannedPayoffChapterId: "chapter-26",
          unresolved: true,
          overdue: false,
          occurrenceCount: 1,
          versionNo: 4
        }],
        page: 1,
        limit: 20,
        hasMore: false,
        nextPage: null
      }
    });
    expect(JSON.stringify(foreshadows.structuredContent)).not.toContain("完整伏笔描述");
    expect(JSON.stringify(foreshadows.structuredContent)).not.toContain("钟针停在归航坐标");
    expect(foreshadow.structuredContent).toEqual({
      foreshadow: {
        id: "foreshadow-1",
        workId: "work-1",
        title: "停摆的航海钟",
        description: "航海钟在每次接近伪造星图时都会停摆。",
        status: "planted",
        importance: "high",
        plannedPayoffChapterId: "chapter-26",
        resolutionNote: "",
        unresolved: true,
        overdue: false,
        occurrences: [{
          id: "occurrence-1",
          foreshadowId: "foreshadow-1",
          chapterId: "chapter-1",
          chapterTitle: "第一章 信号",
          role: "plant",
          note: "钟针停在归航坐标。",
          versionNo: 1
        }],
        versionNo: 4
      }
    });
    expect(fixture.requests.map((request) => request.url)).toEqual([
      "/api/works/work-1/foreshadows?status=unresolved&currentChapterId=chapter-26&page=1&limit=20",
      "/api/foreshadows/foreshadow-1"
    ]);
  });

  it("读取作品写作目标而不返回整段趋势数据", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);

    const result = await client.callTool({
      name: "get_writing_goal",
      arguments: { workId: "work-1" }
    });

    expect(result.structuredContent).toEqual({
      writingGoal: {
        workId: "work-1",
        dailyGoal: 1500,
        targetTotal: 120000,
        deadline: "2027-03-01",
        updatedAt: "2026-10-15T06:00:00.000Z"
      }
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain("trend");
    expect(fixture.requests).toEqual([
      { method: "GET", url: "/api/works/work-1/writing-progress", authorization: "Bearer scrv_test-secret", body: null }
    ]);
  });

  it("按关键词和实体类型搜索当前权限可读的作品资料", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);

    const result = await client.callTool({
      name: "search_work_entities",
      arguments: { workId: "work-1", query: "灰烬", entityType: "character", limit: 10 }
    });

    expect(result.structuredContent).toEqual({
      results: [{
        type: "character",
        id: "character-1",
        title: "沈砚",
        subtitle: "领航员",
        snippet: "曾参与灰烬航标试验。",
        score: 0.032,
        matchKinds: ["exact"]
      }]
    });
    expect(fixture.requests).toEqual([
      {
        method: "GET",
        url: "/api/works/work-1/search?q=%E7%81%B0%E7%83%AC&type=character&limit=10",
        authorization: "Bearer scrv_test-secret",
        body: null
      }
    ]);
  });

  it("在发起搜索请求前拒绝超过一百字符的关键词", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);

    const invalid = await client.callTool({
      name: "search_work_entities",
      arguments: { workId: "work-1", query: "超".repeat(101) }
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
        content: "她能记住所有星图，却认不出自己的名字。",
        idempotencyKey: "draft-setting-idea-0001"
      }
    });

    expect(result.structuredContent).toEqual({
      draft: {
        id: "draft-2",
        workId: "work-1",
        versionNo: 1,
        draftType: "setting",
        settingModule: "characters",
        title: "失忆的领航员",
        content: "她能记住所有星图，却认不出自己的名字。"
      },
      creation: {
        success: true,
        workId: "work-1",
        entityType: "draft",
        entityId: "draft-2",
        title: "失忆的领航员",
        versionNo: 1,
        module: "setting-drafts",
        relatedEntityIds: { settingModule: "characters" }
      }
    });
    expect(fixture.requests[0]).toEqual({
      method: "POST",
      url: "/api/works/work-1/drafts",
      authorization: "Bearer scrv_test-secret",
      idempotencyKey: "draft-setting-idea-0001",
      body: {
        draftType: "setting",
        settingModule: "characters",
        title: "失忆的领航员",
        content: "她能记住所有星图，却认不出自己的名字。"
      }
    });
  });

  it("发现想法重名候选时返回候选，并允许明确确认后继续创建", async () => {
    const fixture = await startScriverseFixture({ draftDuplicate: true });
    const client = await connectMcp(fixture.baseUrl);
    const argumentsBase = {
      workId: "work-1",
      draftType: "setting",
      settingModule: "characters",
      title: "失忆的领航员",
      content: "她能记住所有星图，却认不出自己的名字。",
      idempotencyKey: "draft-duplicate-check-0001"
    };

    const duplicate = await client.callTool({ name: "create_draft", arguments: argumentsBase });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.structuredContent).toEqual({
      error: {
        code: "DUPLICATE_CANDIDATES",
        message: "发现疑似重名的想法，请确认是更新已有记录还是继续新增",
        candidates: [{ id: "draft-existing", entityType: "draft", title: "失忆的领航员", versionNo: 3 }]
      }
    });

    const created = await client.callTool({
      name: "create_draft",
      arguments: { ...argumentsBase, allowDuplicate: true }
    });
    expect(created.isError).not.toBe(true);
    expect(created.structuredContent).toMatchObject({ creation: { success: true, entityId: "draft-2" } });
    expect(fixture.requests.map((entry) => entry.duplicatePolicy)).toEqual([undefined, "create"]);
  });

  it("把世界观内容创建为正式设定并返回统一创建结果", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);

    const created = await client.callTool({
      name: "create_setting",
      arguments: {
        workId: "work-1",
        title: "灰烬航标",
        category: "科技",
        content: "以恒星灰烬校准的远航信标。",
        tags: ["航行", "科技"],
        status: "confirmed",
        idempotencyKey: "setting-create-0001"
      }
    });

    expect(created.structuredContent).toEqual({
      setting: {
        id: "setting-2",
        workId: "work-1",
        versionNo: 1,
        title: "灰烬航标",
        category: "科技",
        content: "以恒星灰烬校准的远航信标。",
        tags: ["航行", "科技"],
        status: "confirmed"
      },
      creation: {
        success: true,
        workId: "work-1",
        entityType: "setting",
        entityId: "setting-2",
        title: "灰烬航标",
        versionNo: 1,
        module: "settings",
        relatedEntityIds: {}
      }
    });
    expect(fixture.requests[0]).toEqual({
      method: "POST",
      url: "/api/works/work-1/settings",
      authorization: "Bearer scrv_test-secret",
      idempotencyKey: "setting-create-0001",
      body: {
        title: "灰烬航标",
        category: "科技",
        content: "以恒星灰烬校准的远航信标。",
        tags: ["航行", "科技"],
        status: "confirmed"
      }
    });
  });

  it("创建正式角色并保留种族、组织和首登场章节关联", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);
    const created = await client.callTool({
      name: "create_character",
      arguments: {
        workId: "work-1",
        name: "沈砚",
        gender: "female",
        aliases: ["领航员"],
        raceId: "race-1",
        organizationIds: ["organization-1"],
        firstChapterId: "chapter-26",
        idempotencyKey: "character-create-0001"
      }
    });

    expect(created.structuredContent).toEqual({
      character: {
        id: "character-2",
        workId: "work-1",
        versionNo: 1,
        name: "沈砚",
        gender: "female",
        aliases: ["领航员"],
        raceId: "race-1",
        organizationIds: ["organization-1"],
        firstChapterId: "chapter-26"
      },
      creation: {
        success: true,
        workId: "work-1",
        entityType: "character",
        entityId: "character-2",
        name: "沈砚",
        versionNo: 1,
        module: "characters",
        relatedEntityIds: {
          raceId: "race-1",
          organizationIds: ["organization-1"],
          firstChapterId: "chapter-26"
        }
      }
    });
    expect(fixture.requests[0]).toMatchObject({
      method: "POST",
      url: "/api/works/work-1/characters",
      authorization: "Bearer scrv_test-secret",
      idempotencyKey: "character-create-0001",
      body: {
        name: "沈砚",
        gender: "female",
        aliases: ["领航员"],
        raceId: "race-1",
        organizationIds: ["organization-1"],
        firstChapterId: "chapter-26"
      }
    });
  });

  it("为角色创建正式扩展资料章节", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);
    const created = await client.callTool({
      name: "create_character_section",
      arguments: {
        characterId: "character-1",
        sectionType: "background",
        title: "灰烬航标事故",
        contentMarkdown: "## 事故\n\n她是唯一的幸存者。",
        summary: "记录沈砚加入舰队前的事故。",
        idempotencyKey: "character-section-create-0001"
      }
    });

    expect(created.structuredContent).toEqual({
      characterSection: {
        id: "section-2",
        workId: "work-1",
        characterId: "character-1",
        versionNo: 1,
        sectionType: "background",
        title: "灰烬航标事故",
        contentMarkdown: "## 事故\n\n她是唯一的幸存者。",
        summary: "记录沈砚加入舰队前的事故。"
      },
      creation: {
        success: true,
        workId: "work-1",
        entityType: "character-section",
        entityId: "section-2",
        title: "灰烬航标事故",
        versionNo: 1,
        module: "characters",
        relatedEntityIds: { characterId: "character-1" }
      }
    });
  });

  it("创建正式种族并返回层级关联", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);
    const created = await client.callTool({
      name: "create_race",
      arguments: {
        workId: "work-1",
        name: "星裔",
        parentRaceId: "race-1",
        description: "诞生于恒星灰烬。",
        idempotencyKey: "race-create-0001"
      }
    });
    expect(created.structuredContent).toMatchObject({
      race: { id: "race-2", workId: "work-1", name: "星裔", parentRaceId: "race-1" },
      creation: {
        success: true,
        entityType: "race",
        entityId: "race-2",
        name: "星裔",
        module: "races",
        relatedEntityIds: { parentRaceId: "race-1" }
      }
    });
  });

  it("创建正式组织并保留成员关联", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);
    const created = await client.callTool({
      name: "create_organization",
      arguments: {
        workId: "work-1",
        name: "归航委员会",
        description: "负责审核舰队归航路线。",
        settingsMarkdown: "## 章程\n\n所有路线必须经过双人复核。",
        memberIds: ["character-1"],
        idempotencyKey: "organization-create-0001"
      }
    });

    expect(created.structuredContent).toEqual({
      organization: {
        id: "organization-2",
        workId: "work-1",
        versionNo: 1,
        name: "归航委员会",
        description: "负责审核舰队归航路线。",
        settingsMarkdown: "## 章程\n\n所有路线必须经过双人复核。",
        memberIds: ["character-1"]
      },
      creation: {
        success: true,
        workId: "work-1",
        entityType: "organization",
        entityId: "organization-2",
        name: "归航委员会",
        versionNo: 1,
        module: "organizations",
        relatedEntityIds: { memberIds: ["character-1"] }
      }
    });
    expect(fixture.requests[0]).toEqual({
      method: "POST",
      url: "/api/works/work-1/organizations",
      authorization: "Bearer scrv_test-secret",
      idempotencyKey: "organization-create-0001",
      body: {
        name: "归航委员会",
        description: "负责审核舰队归航路线。",
        settingsMarkdown: "## 章程\n\n所有路线必须经过双人复核。",
        memberIds: ["character-1"]
      }
    });
  });

  it("创建正式时间轴轨道并返回排序信息", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);
    const created = await client.callTool({
      name: "create_timeline_track",
      arguments: {
        workId: "work-1",
        name: "归航纪年",
        description: "记录舰队返航过程中的关键节点。",
        sortOrder: 2,
        idempotencyKey: "timeline-track-create-0001"
      }
    });

    expect(created.structuredContent).toEqual({
      timelineTrack: {
        id: "track-2",
        workId: "work-1",
        versionNo: 1,
        name: "归航纪年",
        description: "记录舰队返航过程中的关键节点。",
        sortOrder: 2
      },
      creation: {
        success: true,
        workId: "work-1",
        entityType: "timeline-track",
        entityId: "track-2",
        name: "归航纪年",
        versionNo: 1,
        module: "timeline",
        relatedEntityIds: {}
      }
    });
    expect(fixture.requests[0]).toEqual({
      method: "POST",
      url: "/api/works/work-1/timeline-tracks",
      authorization: "Bearer scrv_test-secret",
      idempotencyKey: "timeline-track-create-0001",
      body: {
        name: "归航纪年",
        description: "记录舰队返航过程中的关键节点。",
        sortOrder: 2
      }
    });
  });

  it("创建正式时间轴事件并保留轨道、章节和参与角色关联", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);
    const created = await client.callTool({
      name: "create_timeline_event",
      arguments: {
        workId: "work-1",
        name: "灰烬跃迁",
        trackId: "track-1",
        description: "舰队完成首次跨星区跃迁。",
        eventType: "milestone",
        timeLabel: "新历 17 年",
        chapterIds: ["chapter-26"],
        participantIds: ["character-1"],
        impactScope: "galaxy",
        status: "confirmed",
        idempotencyKey: "timeline-event-create-0001"
      }
    });

    expect(created.structuredContent).toEqual({
      timelineEvent: {
        id: "event-2",
        workId: "work-1",
        versionNo: 1,
        name: "灰烬跃迁",
        trackId: "track-1",
        description: "舰队完成首次跨星区跃迁。",
        eventType: "milestone",
        timeLabel: "新历 17 年",
        chapterIds: ["chapter-26"],
        participantIds: ["character-1"],
        impactScope: "galaxy",
        status: "confirmed"
      },
      creation: {
        success: true,
        workId: "work-1",
        entityType: "timeline-event",
        entityId: "event-2",
        name: "灰烬跃迁",
        versionNo: 1,
        module: "timeline",
        relatedEntityIds: {
          trackId: "track-1",
          chapterIds: ["chapter-26"],
          participantIds: ["character-1"]
        }
      }
    });
    expect(fixture.requests[0]).toMatchObject({
      method: "POST",
      url: "/api/works/work-1/timeline",
      authorization: "Bearer scrv_test-secret",
      idempotencyKey: "timeline-event-create-0001",
      body: expect.objectContaining({
        name: "灰烬跃迁",
        trackId: "track-1",
        chapterIds: ["chapter-26"],
        participantIds: ["character-1"]
      })
    });
  });

  it("创建正式人物关系并返回双方角色关联", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);
    const created = await client.callTool({
      name: "create_relationship",
      arguments: {
        workId: "work-1",
        fromCharacterId: "character-1",
        toCharacterId: "character-2",
        category: "social",
        subtype: "导师",
        keywords: ["舰队", "传承"],
        directed: true,
        confidence: 0.9,
        confirmationStatus: "confirmed",
        idempotencyKey: "relationship-create-0001"
      }
    });

    expect(created.structuredContent).toEqual({
      relationship: {
        id: "relationship-2",
        workId: "work-1",
        versionNo: 1,
        fromCharacterId: "character-1",
        toCharacterId: "character-2",
        category: "social",
        subtype: "导师",
        keywords: ["舰队", "传承"],
        directed: true,
        confidence: 0.9,
        confirmationStatus: "confirmed"
      },
      creation: {
        success: true,
        workId: "work-1",
        entityType: "relationship",
        entityId: "relationship-2",
        title: "character-1 → character-2",
        versionNo: 1,
        module: "relationships",
        relatedEntityIds: {
          fromCharacterId: "character-1",
          toCharacterId: "character-2"
        }
      }
    });
    expect(fixture.requests[0]).toMatchObject({
      method: "POST",
      url: "/api/works/work-1/relationships",
      authorization: "Bearer scrv_test-secret",
      idempotencyKey: "relationship-create-0001",
      body: expect.objectContaining({
        fromCharacterId: "character-1",
        toCharacterId: "character-2",
        category: "social",
        subtype: "导师"
      })
    });
  });

  it("创建正式分卷并返回正文模块位置", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);
    const created = await client.callTool({
      name: "create_volume",
      arguments: {
        workId: "work-1",
        title: "第二卷 归航",
        kind: "main",
        description: "舰队穿越灰烬区后返回故乡。",
        keywords: ["归航", "灰烬区"],
        storyOrder: 2,
        idempotencyKey: "volume-create-0001"
      }
    });

    expect(created.structuredContent).toEqual({
      volume: {
        id: "volume-2",
        workId: "work-1",
        versionNo: 1,
        title: "第二卷 归航",
        kind: "main",
        description: "舰队穿越灰烬区后返回故乡。",
        keywords: ["归航", "灰烬区"],
        storyOrder: 2
      },
      creation: {
        success: true,
        workId: "work-1",
        entityType: "volume",
        entityId: "volume-2",
        title: "第二卷 归航",
        versionNo: 1,
        module: "prose",
        relatedEntityIds: {}
      }
    });
    expect(fixture.requests[0]).toMatchObject({
      method: "POST",
      url: "/api/works/work-1/volumes",
      authorization: "Bearer scrv_test-secret",
      idempotencyKey: "volume-create-0001",
      body: expect.objectContaining({ title: "第二卷 归航", kind: "main", storyOrder: 2 })
    });
  });

  it("创建正式章节并保留分卷与插入锚点关联", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);
    const created = await client.callTool({
      name: "create_chapter",
      arguments: {
        workId: "work-1",
        volumeId: "volume-1",
        title: "第二十七章 灰烬门",
        content: "舰队驶入最后一片灰烬区。",
        chapterType: "正文",
        insertAfterChapterId: "chapter-26",
        idempotencyKey: "chapter-create-0001"
      }
    });

    expect(created.structuredContent).toEqual({
      chapter: {
        id: "chapter-27",
        workId: "work-1",
        versionNo: 1,
        volumeId: "volume-1",
        title: "第二十七章 灰烬门",
        content: "舰队驶入最后一片灰烬区。",
        chapterType: "正文",
        insertAfterChapterId: "chapter-26"
      },
      creation: {
        success: true,
        workId: "work-1",
        entityType: "chapter",
        entityId: "chapter-27",
        title: "第二十七章 灰烬门",
        versionNo: 1,
        module: "prose",
        relatedEntityIds: {
          volumeId: "volume-1",
          insertAfterChapterId: "chapter-26"
        }
      }
    });
    expect(fixture.requests[0]).toMatchObject({
      method: "POST",
      url: "/api/works/work-1/chapters",
      authorization: "Bearer scrv_test-secret",
      idempotencyKey: "chapter-create-0001",
      body: expect.objectContaining({
        volumeId: "volume-1",
        title: "第二十七章 灰烬门",
        insertAfterChapterId: "chapter-26"
      })
    });
  });

  it("为章节创建正式大纲并返回章节关联", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);
    const created = await client.callTool({
      name: "set_chapter_outline",
      arguments: {
        chapterId: "chapter-26",
        goal: "让舰队决定穿越灰烬门。",
        conflict: "燃料不足以支持第二次尝试。",
        turningPoint: "沈砚发现旧航标仍在工作。",
        notes: "结尾切到故乡视角。",
        status: "ready",
        idempotencyKey: "chapter-outline-create-0001"
      }
    });

    expect(created.structuredContent).toEqual({
      chapterOutline: {
        chapterId: "chapter-26",
        workId: "work-1",
        volumeId: "volume-1",
        chapterTitle: "第二十六章 归航",
        versionNo: 1,
        goal: "让舰队决定穿越灰烬门。",
        conflict: "燃料不足以支持第二次尝试。",
        turningPoint: "沈砚发现旧航标仍在工作。",
        notes: "结尾切到故乡视角。",
        status: "ready"
      },
      creation: {
        success: true,
        workId: "work-1",
        entityType: "chapter-outline",
        entityId: "chapter-26",
        title: "第二十六章 归航",
        versionNo: 1,
        module: "outlines",
        relatedEntityIds: { chapterId: "chapter-26", volumeId: "volume-1" }
      }
    });
    expect(fixture.requests[0]).toMatchObject({
      method: "PUT",
      url: "/api/chapters/chapter-26/outline",
      authorization: "Bearer scrv_test-secret",
      idempotencyKey: "chapter-outline-create-0001",
      body: expect.objectContaining({ goal: "让舰队决定穿越灰烬门。", status: "ready" })
    });
  });

  it("创建正式伏笔及其初始章节出现位置", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);
    const created = await client.callTool({
      name: "create_foreshadow",
      arguments: {
        workId: "work-1",
        title: "航海钟上的陌生坐标",
        description: "停摆前浮现的坐标指向灰烬门。",
        status: "planted",
        importance: "high",
        plannedPayoffChapterId: "chapter-26",
        occurrences: [{
          chapterId: "chapter-26",
          role: "setup",
          note: "钟面闪过一行陌生坐标。",
          evidence: []
        }],
        idempotencyKey: "foreshadow-create-0001"
      }
    });

    expect(created.structuredContent).toEqual({
      foreshadow: expect.objectContaining({
        id: "foreshadow-2",
        workId: "work-1",
        title: "航海钟上的陌生坐标",
        versionNo: 1,
        occurrences: [expect.objectContaining({ id: "occurrence-2", chapterId: "chapter-26", role: "setup" })]
      }),
      creation: {
        success: true,
        workId: "work-1",
        entityType: "foreshadow",
        entityId: "foreshadow-2",
        title: "航海钟上的陌生坐标",
        versionNo: 1,
        module: "outlines",
        relatedEntityIds: {
          plannedPayoffChapterId: "chapter-26",
          occurrenceIds: ["occurrence-2"]
        }
      }
    });
    expect(fixture.requests[0]).toMatchObject({
      method: "POST",
      url: "/api/works/work-1/foreshadows",
      authorization: "Bearer scrv_test-secret",
      idempotencyKey: "foreshadow-create-0001",
      body: expect.objectContaining({
        title: "航海钟上的陌生坐标",
        plannedPayoffChapterId: "chapter-26",
        occurrences: [expect.objectContaining({ chapterId: "chapter-26", role: "setup" })]
      })
    });
  });

  it("为已有伏笔添加带版本保护的章节出现位置", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);
    const created = await client.callTool({
      name: "add_foreshadow_occurrence",
      arguments: {
        foreshadowId: "foreshadow-1",
        chapterId: "chapter-26",
        role: "payoff",
        note: "沈砚用坐标开启灰烬门。",
        evidence: [{ source: "chapter", quote: "钟针重新转动。" }],
        expectedVersionNo: 4,
        idempotencyKey: "foreshadow-occurrence-create-0001"
      }
    });

    expect(created.structuredContent).toEqual({
      occurrence: {
        id: "occurrence-3",
        foreshadowId: "foreshadow-1",
        workId: "work-1",
        chapterId: "chapter-26",
        chapterTitle: "第二十六章 归航",
        volumeId: "volume-1",
        volumeTitle: "第一卷",
        role: "payoff",
        note: "沈砚用坐标开启灰烬门。",
        evidence: [{ source: "chapter", quote: "钟针重新转动。" }],
        foreshadowVersionNo: 5
      },
      creation: {
        success: true,
        workId: "work-1",
        entityType: "foreshadow-occurrence",
        entityId: "occurrence-3",
        title: "第二十六章 归航",
        versionNo: 5,
        module: "outlines",
        relatedEntityIds: {
          foreshadowId: "foreshadow-1",
          chapterId: "chapter-26",
          volumeId: "volume-1"
        }
      }
    });
    expect(fixture.requests[0]).toMatchObject({
      method: "POST",
      url: "/api/foreshadows/foreshadow-1/occurrences",
      authorization: "Bearer scrv_test-secret",
      idempotencyKey: "foreshadow-occurrence-create-0001",
      body: expect.objectContaining({
        chapterId: "chapter-26",
        role: "payoff",
        expectedVersionNo: 4
      })
    });
  });

  it("为正文行创建正式评论并返回锚点信息", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);
    const created = await client.callTool({
      name: "create_chapter_comment",
      arguments: {
        chapterId: "chapter-26",
        startLine: 3,
        endLine: 4,
        note: "这里需要提示坐标与灰烬门的联系。",
        idempotencyKey: "chapter-comment-create-0001"
      }
    });

    expect(created.structuredContent).toEqual({
      comment: {
        id: "annotation-1",
        workId: "work-1",
        chapterId: "chapter-26",
        kind: "note",
        startLine: 3,
        endLine: 4,
        quote: "航海钟突然停摆。\n钟面浮现陌生坐标。",
        note: "这里需要提示坐标与灰烬门的联系。",
        status: "open",
        versionNo: 1
      },
      creation: {
        success: true,
        workId: "work-1",
        entityType: "chapter-comment",
        entityId: "annotation-1",
        title: "第 3-4 行评论",
        versionNo: 1,
        module: "comments",
        relatedEntityIds: { chapterId: "chapter-26" }
      }
    });
    expect(fixture.requests[0]).toMatchObject({
      method: "POST",
      url: "/api/chapters/chapter-26/annotations",
      authorization: "Bearer scrv_test-secret",
      idempotencyKey: "chapter-comment-create-0001",
      body: {
        kind: "note",
        startLine: 3,
        endLine: 4,
        note: "这里需要提示坐标与灰烬门的联系。"
      }
    });
  });

  it("创建正式审核记录并保留实体引用", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);
    const created = await client.callTool({
      name: "create_review_record",
      arguments: {
        workId: "work-1",
        itemType: "continuity",
        dedupeKey: "chapter-26-clock-coordinate",
        severity: "high",
        title: "航海钟坐标前后不一致",
        description: "第三章与第二十六章使用了不同坐标。",
        entityRefs: [{ type: "chapter", id: "chapter-26" }],
        evidence: [{ chapterId: "chapter-26", quote: "钟针重新转动。" }],
        suggestion: "统一为第三章首次出现的坐标。",
        idempotencyKey: "review-record-create-0001"
      }
    });

    expect(created.structuredContent).toEqual({
      review: expect.objectContaining({
        id: "review-1",
        workId: "work-1",
        itemType: "continuity",
        title: "航海钟坐标前后不一致",
        status: "pending"
      }),
      creation: {
        success: true,
        workId: "work-1",
        entityType: "review",
        entityId: "review-1",
        title: "航海钟坐标前后不一致",
        versionNo: 1,
        module: "reviews",
        relatedEntityIds: {}
      }
    });
    expect(fixture.requests[0]).toMatchObject({
      method: "POST",
      url: "/api/works/work-1/reviews",
      authorization: "Bearer scrv_test-secret",
      idempotencyKey: "review-record-create-0001",
      body: expect.objectContaining({
        itemType: "continuity",
        dedupeKey: "chapter-26-clock-coordinate",
        entityRefs: [{ type: "chapter", id: "chapter-26" }]
      })
    });
  });

  it("首次设置写作目标并返回精简结果", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);
    const created = await client.callTool({
      name: "set_writing_goal",
      arguments: {
        workId: "work-1",
        dailyGoal: 2000,
        targetTotal: 120000,
        deadline: "2027-03-01",
        idempotencyKey: "writing-goal-create-0001"
      }
    });

    expect(created.structuredContent).toEqual({
      writingGoal: {
        workId: "work-1",
        dailyGoal: 2000,
        targetTotal: 120000,
        deadline: "2027-03-01",
        updatedAt: "2026-10-16T01:00:00.000Z"
      },
      creation: {
        success: true,
        workId: "work-1",
        entityType: "writing-goal",
        entityId: "work-1",
        title: "写作目标",
        versionNo: 1,
        module: "prose",
        relatedEntityIds: {}
      }
    });
    expect(fixture.requests[0]).toEqual({
      method: "PUT",
      url: "/api/works/work-1/writing-goal",
      authorization: "Bearer scrv_test-secret",
      idempotencyKey: "writing-goal-create-0001",
      body: { dailyGoal: 2000, targetTotal: 120000, deadline: "2027-03-01" }
    });
  });

  it("使用期望版本号安全更新想法", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);
    const updated = await client.callTool({
      name: "update_draft",
      arguments: {
        draftId: "draft-3",
        title: "观星会的密约",
        content: "他们记录每一颗熄灭的恒星。",
        changeNote: "补充组织秘密",
        expectedVersionNo: 2
      }
    });

    expect(updated.structuredContent).toEqual({
      draft: {
        id: "draft-3",
        workId: "work-1",
        draftType: "setting",
        settingModule: "organizations",
        title: "观星会的密约",
        content: "他们记录每一颗熄灭的恒星。",
        versionNo: 3
      }
    });
    expect(fixture.requests[0]).toEqual({
      method: "PATCH",
      url: "/api/drafts/draft-3",
      authorization: "Bearer scrv_test-secret",
      body: {
        title: "观星会的密约",
        content: "他们记录每一颗熄灭的恒星。",
        changeNote: "补充组织秘密",
        expectedVersionNo: 2
      }
    });
  });

  it("使用期望版本号安全更新正式设定", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);
    const updated = await client.callTool({
      name: "update_setting",
      arguments: {
        settingId: "setting-1",
        title: "灰烬航标协议",
        content: "灰烬航标需要两名领航员共同校准。",
        tags: ["航行"],
        status: "confirmed",
        changeNote: "确认校准规则",
        expectedVersionNo: 4
      }
    });

    expect(updated.structuredContent).toEqual({
      setting: {
        id: "setting-1",
        workId: "work-1",
        title: "灰烬航标协议",
        category: "科技",
        content: "灰烬航标需要两名领航员共同校准。",
        tags: ["航行"],
        status: "confirmed",
        versionNo: 5
      }
    });
    expect(fixture.requests[0]).toEqual({
      method: "PATCH",
      url: "/api/settings/setting-1",
      authorization: "Bearer scrv_test-secret",
      body: {
        title: "灰烬航标协议",
        content: "灰烬航标需要两名领航员共同校准。",
        tags: ["航行"],
        status: "confirmed",
        changeNote: "确认校准规则",
        expectedVersionNo: 4
      }
    });
  });

  it("使用期望版本号安全更新正式角色", async () => {
    const fixture = await startScriverseFixture();
    const client = await connectMcp(fixture.baseUrl);
    const updated = await client.callTool({
      name: "update_character",
      arguments: {
        characterId: "character-1",
        code: "领航者",
        aliases: ["阿砚"],
        organizationIds: ["organization-1"],
        changeNote: "补充角色代号",
        expectedVersionNo: 5
      }
    });

    expect(updated.structuredContent).toEqual({
      character: {
        id: "character-1",
        workId: "work-1",
        name: "沈砚",
        code: "领航者",
        aliases: ["阿砚"],
        role: "领航员",
        raceId: "race-1",
        organizationIds: ["organization-1"],
        versionNo: 6
      }
    });
    expect(fixture.requests[0]).toEqual({
      method: "PATCH",
      url: "/api/characters/character-1",
      authorization: "Bearer scrv_test-secret",
      body: {
        code: "领航者",
        aliases: ["阿砚"],
        organizationIds: ["organization-1"],
        changeNote: "补充角色代号",
        expectedVersionNo: 5
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
