import { existsSync } from "node:fs";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
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
	process.env.IRAB_TOOL_MODE = "replay";
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

describe("IRaB finance tools extension", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		process.env.IRAB_TOOL_MODE = "replay";
		delete process.env.IRAB_PAIPAI_BASE_URL;
		delete process.env.IRAB_GLOBAL_DATA_BASE_URL;
		delete process.env.IRAB_WEBSEARCH_SERVICE_URL;
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

	it("returns numbered replay source artifacts", async () => {
		const { tools } = registerIrabExtension();
		const tool = getOnlyExtensionTool(tools, "search_paipai");

		const toolResult = await tool.execute(
			"call_1",
			{ query: "BYD battery margin", limit: 2 },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const text = textFromToolResult(toolResult);

		expect(text).toContain("Found 2 items");
		expect(text).toContain("[source:");
		expect(text).not.toContain("[Reference");
		expect(text).toContain("BYD's fourth-quarter gross margin improvement");
		expect(text).not.toContain("citation_contract");
		expect(toolResult.details).toMatchObject({
			mode: "replay",
			tool: "search_paipai",
			query: "BYD battery margin",
			fixture_version: 1,
		});
		expect(irabDetails(toolResult).artifacts[0]).toMatchObject({
			type: "text",
			source: "search_paipai",
		});
	});

	it("stores replay table artifacts as CSV files", async () => {
		const { tools } = registerIrabExtension();
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
		expect(filePath).toBeTruthy();
		expect(existsSync(filePath ?? "")).toBe(true);
		expect(details.artifact_dir).toBeTruthy();
	});

	it("serializes live CN marketdata chunks as table previews", async () => {
		const { tools } = registerIrabExtension();
		process.env.IRAB_TOOL_MODE = "live";
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

	it("fetches a replay URL as a numbered reference artifact", async () => {
		const { tools } = registerIrabExtension();
		const tool = getOnlyExtensionTool(tools, "fetch_web");

		const toolResult = await tool.execute(
			"call_3",
			{ url: "https://www.sec.gov/Archives/edgar/data/320193/replay/aapl-2026q2-10q.htm" },
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
		process.env.IRAB_TOOL_MODE = "live";
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
