import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import irabFinanceToolsExtension from "../../../packages/irab-finance-tools/src/index.ts";
import type { ExtensionAPI, ExtensionContext, ProviderConfig, ToolDefinition } from "../src/core/extensions/index.ts";

type RegisteredIrabExtension = {
	providers: Map<string, ProviderConfig>;
	tools: Map<string, ToolDefinition>;
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

const requestedRabyteModelIds = [
	"kimi-k2.6-thinking",
	"openrouter-mimo-v2.5-pro",
	"wangsu-claude-opus-4-6",
	"openrouter-deepseek-v4-pro",
	"glm-5.1-thinking",
	"openai-gpt-5.5",
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
	"IRAB_TOOL_TIMEOUT_MS",
	"IRAB_TOOL_RETRY_BASE_MS",
	"IRAB_ARTIFACT_DIR",
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
			"read_public_webpage",
			"search_china_market_data",
			"search_global_market_data",
			"search_public_web",
			"search_research_corpus",
		]);
	});

	it("registers the Rabyte provider with DeepTask models", async () => {
		const { providers } = registerIrabExtension();
		const provider = providers.get("rabyte");
		const models = provider?.models ?? [];

		expect(provider).toMatchObject({
			api: "openai-completions",
			apiKey: "$IRAB_TOKEN",
			baseUrl: "https://test-llm.rabyte.cn/irab/v1",
			name: "IRaB Gateway",
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
		expect(models.find((model) => model.id === "openai-gpt-5.5")?.compat).toMatchObject({
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

	it("uses IRAB_GATEWAY_URL when configured", async () => {
		process.env.IRAB_GATEWAY_URL = "https://gateway.test/irab";
		const { providers } = registerIrabExtension();
		const provider = providers.get("rabyte");

		expect(provider).toMatchObject({
			api: "openai-completions",
			apiKey: "$IRAB_TOKEN",
			baseUrl: "https://gateway.test/irab/v1",
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
							source_id: "research-byd-margin",
							title: "BYD 2025 Q4 margin review",
							content:
								"BYD's fourth-quarter gross margin improvement came from battery cost reductions and a richer export mix.",
							date: "2026-02-18",
							publisher: "IRaB Research Corpus",
							url: "irab://source/research-byd-margin",
							table: null,
							metadata: { sanitized: false },
						},
					],
				}),
				{ status: 200 },
			);
		});
		const { tools } = registerIrabExtension();
		const tool = getOnlyExtensionTool(tools, "search_research_corpus");

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
			url: "https://gateway.test/irab/v1/tools/search_research_corpus",
			authorization: "Bearer irab_test",
		});
		const requestBody = JSON.parse(requests[0]?.body ?? "{}") as Record<string, unknown>;
		expect(requestBody).toMatchObject({
			query: "BYD battery margin",
			limit: 1,
		});
		expect(text).toContain("Found 1 item");
		expect(text).toContain("[source:");
		expect(toolResult.details).toMatchObject({
			mode: "gateway",
			tool: "search_research_corpus",
			endpoint: "https://gateway.test/irab/v1/tools/search_research_corpus",
			recording_id: "rec_1",
		});
	});

	it("defaults gateway search results to ten records", async () => {
		process.env.IRAB_TOKEN = "irab_test";
		process.env.IRAB_GATEWAY_URL = "https://gateway.test/irab";
		const requests: { body: string }[] = [];
		vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
			requests.push({ body: String(init?.body ?? "") });
			return new Response(
				JSON.stringify({
					message: "Found 12 items",
					records: Array.from({ length: 12 }, (_, index) => ({
						source_id: `research-${index + 1}`,
						title: `Research item ${index + 1}`,
						content: `Evidence item ${index + 1}.`,
						date: "2026-02-18",
						publisher: "IRaB Research Corpus",
						url: `irab://source/research-${index + 1}`,
						table: null,
						metadata: {},
					})),
				}),
				{ status: 200 },
			);
		});
		const { tools } = registerIrabExtension();
		const tool = getOnlyExtensionTool(tools, "search_research_corpus");

		const toolResult = await tool.execute(
			"default_limit",
			{ query: "BYD battery margin" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		const requestBody = JSON.parse(requests[0]?.body ?? "{}") as Record<string, unknown>;
		const details = toolResult.details as { results: unknown[] };
		expect(requestBody).not.toHaveProperty("limit");
		expect(details.results).toHaveLength(10);
		expect(textFromToolResult(toolResult)).toContain("Evidence item 10");
		expect(textFromToolResult(toolResult)).not.toContain("Evidence item 11");
	});

	it("does not cap an explicit gateway search limit", async () => {
		process.env.IRAB_TOKEN = "irab_test";
		process.env.IRAB_GATEWAY_URL = "https://gateway.test/irab";
		const requests: { body: string }[] = [];
		vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
			requests.push({ body: String(init?.body ?? "") });
			return new Response(
				JSON.stringify({
					message: "Found 35 items",
					records: Array.from({ length: 35 }, (_, index) => ({
						source_id: `research-${index + 1}`,
						title: `Research item ${index + 1}`,
						content: `Evidence item ${index + 1}.`,
						date: "2026-02-18",
						publisher: "IRaB Research Corpus",
						url: `irab://source/research-${index + 1}`,
						table: null,
						metadata: {},
					})),
				}),
				{ status: 200 },
			);
		});
		const { tools } = registerIrabExtension();
		const tool = getOnlyExtensionTool(tools, "search_research_corpus");

		const toolResult = await tool.execute(
			"explicit_limit",
			{ query: "BYD battery margin", limit: 35 },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		const requestBody = JSON.parse(requests[0]?.body ?? "{}") as Record<string, unknown>;
		const details = toolResult.details as { results: unknown[] };
		expect(requestBody).toMatchObject({ limit: 35 });
		expect(details.results).toHaveLength(35);
		expect(textFromToolResult(toolResult)).toContain("Evidence item 35");
	});

	it("retries transient gateway token concurrency limits", async () => {
		process.env.IRAB_TOKEN = "irab_test";
		process.env.IRAB_GATEWAY_URL = "https://gateway.test/irab";
		process.env.IRAB_TOOL_RETRY_BASE_MS = "1";
		const responses = [
			new Response(JSON.stringify({ error: "IRAB token concurrency limit exceeded" }), { status: 429 }),
			new Response(
				JSON.stringify({
					message: "Found 1 item",
					records: [
						{
							source_id: "research-byd-margin",
							title: "BYD 2025 Q4 margin review",
							content: "BYD battery margin evidence.",
							date: "2026-02-18",
							publisher: "IRaB Research Corpus",
							url: "irab://source/research-byd-margin",
							table: null,
							metadata: {},
						},
					],
				}),
				{ status: 200 },
			),
		];
		vi.stubGlobal("fetch", async () => {
			const response = responses.shift();
			if (!response) throw new Error("Unexpected extra request");
			return response;
		});
		const { tools } = registerIrabExtension();
		const tool = getOnlyExtensionTool(tools, "search_research_corpus");

		const toolResult = await tool.execute(
			"retry_gateway",
			{ query: "BYD battery margin", limit: 1 },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(responses).toHaveLength(0);
		expect(textFromToolResult(toolResult)).toContain("Found 1 item");
	});
});
