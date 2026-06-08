import { existsSync } from "node:fs";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import irabFinanceToolsExtension from "../../../packages/irab-finance-tools/src/index.ts";
import type { ExtensionAPI, ExtensionContext, ProviderConfig, ToolDefinition } from "../src/core/extensions/index.ts";

type RegisteredIrabExtension = {
	providers: Map<string, ProviderConfig>;
	tools: Map<string, ToolDefinition>;
};

type IrabToolDetailsForTest = {
	artifact_dir?: string;
	artifacts: {
		type: string;
		label: string;
		source: string;
		file_path?: string;
	}[];
};

function registerIrabExtension(): RegisteredIrabExtension {
	const providers = new Map<string, ProviderConfig>();
	const tools = new Map<string, ToolDefinition>();
	irabFinanceToolsExtension({
		registerProvider(name, config) {
			providers.set(name, config);
		},
		registerTool(tool) {
			tools.set(tool.name, tool as unknown as ToolDefinition);
		},
	} as ExtensionAPI);
	return { providers, tools };
}

function getOnlyExtensionTool(tools: Map<string, ToolDefinition>, name: string): ToolDefinition {
	const tool = tools.get(name);
	if (!tool) throw new Error(`Missing tool ${name}`);
	return tool;
}

function textFromToolResult(result: AgentToolResult<unknown>): string {
	const first = result.content[0];
	if (!first || first.type !== "text") return "";
	return first.text;
}

function irabDetails(result: AgentToolResult<unknown>): IrabToolDetailsForTest {
	return result.details as IrabToolDetailsForTest;
}

const requestedRabyteModelIds = [
	"kimi-k2.6-thinking",
	"openrouter-mimo-v2.5-pro",
	"wangsu-claude-opus-4-6",
	"openrouter-deepseek-v4-pro",
	"glm-5.1-thinking",
	"wangsu-gpt-5.5",
	"ucloud-claude-opus-4-8",
	"qwen3.7-max",
	"wangsu-gemini-3.5-flash",
	"openrouter-minimax-m3",
];

const deepTaskReasoningReplayModelIds = [
	"kimi-k2.6-thinking",
	"openrouter-mimo-v2.5-pro",
	"openrouter-deepseek-v4-pro",
	"glm-5.1-thinking",
	"qwen3.7-max",
];

const irabEnvKeys = [
	"IRAB_TOKEN",
	"IRAB_GATEWAY_URL",
	"IRAB_RABYTE_BASE_URL",
	"IRAB_RABYTE_OPENAI_BASE_URL",
	"IRAB_RABYTE_API_KEY",
	"IRAB_PAIPAI_BASE_URL",
	"IRAB_GLOBAL_DATA_BASE_URL",
	"IRAB_WEBSEARCH_SERVICE_URL",
	"IRAB_XIAOSU_READER_URL",
	"IRAB_XIAOSU_READER_OVERSEAS_URL",
	"IRAB_XIAOSU_READER_ACCESS_KEY",
	"RABYTE_BASE_URL",
	"RABYTE_OPENAI_BASE_URL",
	"RABYTE_API_KEY",
	"PAIPAI_BASE_URL",
	"PAIPAI_API_KEY",
	"PAIPAI_APP_AGENT",
	"PAIPAI_SIGN",
	"GLOBAL_DATA_BASE_URL",
	"WEBSEARCH_SERVICE_URL",
	"XIAOSU_READER_URL",
	"XIAOSU_READER_OVERSEAS_URL",
	"XIAOSU_READER_ACCESS_KEY",
];

function clearIrabEnv(): void {
	for (const key of irabEnvKeys) {
		process.env[key] = "";
	}
}

describe("IRaB finance tools extension", () => {
	beforeEach(() => {
		clearIrabEnv();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		clearIrabEnv();
	});

	it("registers the five benchmark tools", async () => {
		const { tools } = registerIrabExtension();

		expect([...tools.keys()].sort()).toEqual([
			"fetch_web",
			"search_cn_marketdata",
			"search_global_data",
			"search_paipai",
			"search_web",
		]);
	});

	it("registers the Rabyte provider with DeepTask models", async () => {
		const { providers } = registerIrabExtension();
		const provider = providers.get("rabyte");
		const models = provider?.models ?? [];

		expect(provider).toMatchObject({
			api: "openai-completions",
			apiKey: "$IRAB_RABYTE_API_KEY",
			baseUrl: "https://test-llm.rabyte.cn/v1",
		});
		expect(models.map((model) => model.id)).toEqual(expect.arrayContaining(requestedRabyteModelIds));
		for (const modelId of deepTaskReasoningReplayModelIds) {
			expect(models.find((model) => model.id === modelId)?.compat).toMatchObject({
				requiresReasoningContentOnAssistantMessages: true,
			});
		}
		expect(models.find((model) => model.id === "kimi-k2.6-thinking")?.compat).toMatchObject({
			sendPromptCacheKey: true,
		});
		expect(models.find((model) => model.id === "wangsu-gpt-5.5")?.compat).toMatchObject({
			sendPromptCacheKey: true,
		});
		expect(models.find((model) => model.id === "ucloud-claude-opus-4-8")?.compat).toMatchObject({
			cacheControlFormat: "anthropic",
		});
		expect(models.find((model) => model.id === "openrouter-deepseek-v4-pro")?.compat).toMatchObject({
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "openrouter",
		});
		expect(models.find((model) => model.id === "glm-5.1-thinking")?.compat).toMatchObject({
			thinkingFormat: "zai",
		});
		expect(models.find((model) => model.id === "qwen3.7-max")?.compat).toMatchObject({
			cacheControlFormat: "anthropic",
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "qwen",
		});
	});

	it("uses IRAB_TOKEN for the hosted gateway provider", async () => {
		process.env.IRAB_TOKEN = "irab_test";
		const { providers } = registerIrabExtension();
		const provider = providers.get("rabyte");

		expect(provider).toMatchObject({
			api: "openai-completions",
			apiKey: "$IRAB_TOKEN",
			baseUrl: "https://test-llm.rabyte.cn/irab/v1",
			name: "IRaB Gateway",
		});
	});

	it("routes token-backed tools through the IRaB gateway", async () => {
		process.env.IRAB_TOKEN = "irab_test";
		process.env.IRAB_GATEWAY_URL = "https://gateway.test/irab";
		const requests: { url: string; authorization: string; body: string }[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			requests.push({
				url: String(input),
				authorization: headers.get("authorization") ?? "",
				body: String(init?.body ?? ""),
			});
			return new Response(
				JSON.stringify({
					message: "Found 1 item",
					recording_id: "rec_1",
					records: [
						{
							source_id: "paipai-byd-margin",
							title: "BYD 2025 Q4 margin review",
							content:
								"BYD's fourth-quarter gross margin improvement came from battery cost reductions and a richer export mix.",
							date: "2026-02-18",
							publisher: "PaiPai Research",
							url: "irab://source/paipai-byd-margin",
							table: null,
							metadata: { sanitized: false },
						},
					],
				}),
				{ status: 200 },
			);
		});
		const { tools } = registerIrabExtension();
		const tool = getOnlyExtensionTool(tools, "search_paipai");

		const toolResult = await tool.execute(
			"call_gateway",
			{ query: "BYD battery margin", limit: 1 },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const text = textFromToolResult(toolResult);

		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			url: "https://gateway.test/irab/v1/tools/search_paipai",
			authorization: "Bearer irab_test",
		});
		expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
			query: "BYD battery margin",
			limit: 1,
		});
		expect(text).toContain("Found 1 item");
		expect(text).toContain("[source:");
		expect(toolResult.details).toMatchObject({
			mode: "gateway",
			tool: "search_paipai",
			endpoint: "https://gateway.test/irab/v1/tools/search_paipai",
			recording_id: "rec_1",
		});
	});

	it("serializes live PaiPai results as numbered source artifacts", async () => {
		const { tools } = registerIrabExtension();
		process.env.IRAB_PAIPAI_BASE_URL = "https://paipai.test";
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{
								id: "paipai-byd-margin",
								title: "BYD 2025 Q4 margin review",
								content:
									"BYD's fourth-quarter gross margin improvement came from battery cost reductions and a richer export mix.",
								publish_time: "2026-02-18",
								source: "PaiPai Research",
							},
						],
					}),
					{ status: 200 },
				),
		);
		const tool = getOnlyExtensionTool(tools, "search_paipai");

		const toolResult = await tool.execute(
			"call_1",
			{ query: "BYD battery margin", limit: 1 },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const text = textFromToolResult(toolResult);

		expect(text).toContain("Found 1 item");
		expect(text).toContain("[source:");
		expect(text).not.toContain("[Reference");
		expect(text).toContain("BYD's fourth-quarter gross margin improvement");
		expect(text).not.toContain("citation_contract");
		expect(toolResult.details).toMatchObject({
			mode: "live",
			tool: "search_paipai",
			query: "BYD battery margin",
			endpoint: "https://paipai.test/paipai_data",
		});
		expect(irabDetails(toolResult).artifacts[0]).toMatchObject({
			type: "text",
			source: "search_paipai",
		});
	});

	it("stores live global-data table artifacts as CSV files", async () => {
		const { tools } = registerIrabExtension();
		process.env.IRAB_GLOBAL_DATA_BASE_URL = "https://global-data.test";
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{
								chunks:
									"| symbol | date | marketCap |\n| --- | --- | --- |\n| AAPL | 2026-06-05 | 4514011993040 |",
								indic_names: ["Apple daily market snapshot"],
							},
						],
					}),
					{ status: 200 },
				),
		);
		const tool = getOnlyExtensionTool(tools, "search_global_data");

		const toolResult = await tool.execute(
			"call_2",
			{ query: "Apple daily market snapshot", limit: 1 },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const text = textFromToolResult(toolResult);
		const details = irabDetails(toolResult);
		const filePath = details.artifacts[0]?.file_path;

		expect(text).toContain("[source:");
		expect(text).not.toContain("[Table");
		expect(text).toContain("Data preview:");
		expect(text).toContain("File:");
		expect(text).toContain("AAPL");
		expect(filePath).toBeTruthy();
		expect(existsSync(filePath ?? "")).toBe(true);
		expect(details.artifact_dir).toBeTruthy();
	});

	it("serializes live CN marketdata chunks as table previews", async () => {
		const { tools } = registerIrabExtension();
		process.env.IRAB_PAIPAI_BASE_URL = "https://paipai.test";
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{
								id: "cn-cpi-1",
								content: "China CPI inflation latest data 2025",
								chunks:
									"| 统计日期 | 指标 | 最新值 |\n| --- | --- | --- |\n| 2025-05 | CPI | 0.3 |\n| 2025-06 | CPI | 0.4 |",
								indic_names: ["China CPI"],
								orig_inst_source: ["National Bureau"],
							},
						],
					}),
					{ status: 200 },
				),
		);
		const tool = getOnlyExtensionTool(tools, "search_cn_marketdata");

		const toolResult = await tool.execute(
			"call_cn_marketdata",
			{ query: "China CPI inflation latest data 2025", limit: 1 },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const text = textFromToolResult(toolResult);

		expect(text).toContain("Got 1 table");
		expect(text).toContain("[source:");
		expect(text).toContain("Data preview:");
		expect(text).toContain("2025-06");
		expect(text).toContain("2025-05");
		expect(text.indexOf("2025-06")).toBeLessThan(text.indexOf("2025-05"));
		expect(text).not.toMatch(/\[source:\d+\]China CPI inflation latest data 2025/u);
		expect(irabDetails(toolResult).artifacts[0]).toMatchObject({
			type: "table",
			source: "search_cn_marketdata",
		});
	});

	it("fetches a URL as a numbered reference artifact", async () => {
		const { tools } = registerIrabExtension();
		process.env.IRAB_XIAOSU_READER_URL = "";
		process.env.IRAB_XIAOSU_READER_OVERSEAS_URL = "";
		process.env.IRAB_XIAOSU_READER_ACCESS_KEY = "";
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response("Apple reported net sales of 95.4 billion USD for the quarter ended March 28, 2026.", {
					status: 200,
				}),
		);
		const tool = getOnlyExtensionTool(tools, "fetch_web");

		const toolResult = await tool.execute(
			"call_3",
			{ url: "https://www.sec.gov/Archives/edgar/data/320193/aapl-2026q2-10q.htm" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const text = textFromToolResult(toolResult);

		expect(text).toContain("Read successful");
		expect(text).toContain("[source:");
		expect(text).not.toContain("[Reference");
		expect(text).toContain("Apple reported net sales");
	});

	it("serializes live web search snippets without full page content", async () => {
		const { tools } = registerIrabExtension();
		process.env.IRAB_WEBSEARCH_SERVICE_URL = "https://web-search.test";
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					JSON.stringify({
						results: [
							{
								query: "market selloff",
								webpages: [
									{
										title: "Markets face triple threat",
										snippet: "Stocks fell as AI shares sold off and oil prices rose.",
										content: "FULL PAGE BODY Trendingnow Lorem ipsum repeated boilerplate",
										link: "https://fortune.example/markets",
										date: "2026-06-08",
										authors: ["Jason Ma"],
										site_name: "Fortune",
									},
								],
							},
						],
					}),
					{ status: 200 },
				),
		);
		const tool = getOnlyExtensionTool(tools, "search_web");

		const toolResult = await tool.execute(
			"call_4",
			{ query: "market selloff", limit: 1 },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const text = textFromToolResult(toolResult);

		expect(text).toContain("[source:");
		expect(text).not.toContain("[Reference");
		expect(text).toContain("Stocks fell as AI shares sold off and oil prices rose.");
		expect(text).not.toContain("FULL PAGE BODY");
		expect(text).not.toContain("Trendingnow");
	});
});
