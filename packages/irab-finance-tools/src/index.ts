import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ProviderConfig, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_FIXTURE_PATH = fileURLToPath(new URL("../fixtures/replay-fixtures.json", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DEFAULT_RABYTE_BASE_URL = "https://test-llm.rabyte.cn";
const DEFAULT_ARTIFACT_DIR = join(REPO_ROOT, "tmp", "irab-artifacts");

type IrabSearchToolName = "search_paipai" | "search_global_data" | "search_cn_marketdata" | "search_web";
type IrabToolName = IrabSearchToolName | "fetch_web";
type IrabToolMode = "replay" | "live";

type EvidenceCell = string | number | boolean | null;

type EvidenceTable = {
	columns: string[];
	rows: Record<string, EvidenceCell>[];
};

type EvidenceRecord = {
	source_id: string;
	title: string;
	date: string;
	publisher: string;
	url: string;
	content: string;
	table: EvidenceTable | null;
	metadata: Record<string, unknown>;
};

type ReplayFixtureFile = {
	version: number;
	records: Record<IrabSearchToolName, EvidenceRecord[]>;
};

type IrabToolDetails = {
	mode: IrabToolMode;
	tool: IrabToolName;
	query: string;
	results: EvidenceRecord[];
	artifacts: SerializedArtifactDetails[];
	artifact_dir?: string;
	fixture_version?: number;
	endpoint?: string;
	message?: string;
};

type SerializedArtifactDetails = {
	id: number;
	type: IrabArtifact["type"];
	label: string;
	source: string;
	file_path?: string;
	url?: string;
	title?: string;
	metadata: Record<string, unknown>;
};

type TextArtifact = {
	id: number;
	type: "text";
	content: string;
	source: string;
	metadata: Record<string, unknown>;
};

type ImageArtifact = {
	id: number;
	type: "image";
	source: string;
	url: string;
	filePath?: string;
	title: string;
	description: string;
	metadata: Record<string, unknown>;
};

type TableArtifact = {
	id: number;
	type: "table";
	source: string;
	table: EvidenceTable;
	filePath: string;
	instSource: string;
	preview: string;
	metadata: Record<string, unknown>;
};

type MessageArtifact = {
	id: number;
	type: "message";
	source: string;
	content: string;
	metadata: Record<string, unknown>;
};

type ErrorArtifact = {
	id: number;
	type: "error";
	source: string;
	errorType: string;
	content: string;
	metadata: Record<string, unknown>;
};

type IrabArtifact = TextArtifact | ImageArtifact | TableArtifact | MessageArtifact | ErrorArtifact;

type SearchExecutionParams = {
	query: string;
	limit?: number;
	sources?: string[];
	start_time?: string;
	end_time?: string;
	include_domains?: string[];
	exclude_domains?: string[];
	user_id?: string;
};

type LiveConfig = {
	paipaiBaseUrl: string;
	paipaiApiKey: string;
	paipaiAppAgent: string;
	paipaiSign: string;
	globalDataBaseUrl: string;
	websearchServiceUrl: string;
	xiaosuReaderUrl: string;
	xiaosuReaderOverseasUrl: string;
	xiaosuReaderAccessKey: string;
	toolTimeoutMs: number;
};

type HttpJsonResult = {
	status: number;
	payload: unknown;
};

type ScoredRecord = {
	record: EvidenceRecord;
	score: number;
};

type IrabToolDetailsInput = Omit<IrabToolDetails, "artifacts">;

const rabyteCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
} as const;

const rabyteModels = [
	{
		id: "wangsu-claude-opus-4-6",
		name: "Wangsu Claude Opus 4.6",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
		compat: { ...rabyteCompat, cacheControlFormat: "anthropic" },
	},
	{
		id: "ucloud-claude-opus-4-8",
		name: "UCloud Claude Opus 4.8",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
		compat: { ...rabyteCompat, cacheControlFormat: "anthropic" },
	},
	{
		id: "kimi-k2.6-thinking",
		name: "Kimi K2.6 Thinking",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 262_144,
		compat: {
			...rabyteCompat,
			requiresReasoningContentOnAssistantMessages: true,
			sendPromptCacheKey: true,
		},
	},
	{
		id: "wangsu-gpt-5.5",
		name: "Wangsu GPT 5.5",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
		compat: { ...rabyteCompat, sendPromptCacheKey: true },
	},
	{
		id: "wangsu-gemini-3.5-flash",
		name: "Wangsu Gemini 3.5 Flash",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		compat: rabyteCompat,
	},
	{
		id: "openrouter-deepseek-v4-pro",
		name: "OpenRouter DeepSeek V4 Pro",
		reasoning: true,
		thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "xhigh" },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 384_000,
		compat: {
			...rabyteCompat,
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "openrouter",
		},
	},
	{
		id: "glm-5.1-thinking",
		name: "GLM 5.1 Thinking",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 131_072,
		compat: {
			...rabyteCompat,
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "zai",
		},
	},
	{
		id: "qwen3.7-max",
		name: "Qwen3.7 Max",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		compat: {
			...rabyteCompat,
			cacheControlFormat: "anthropic",
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "qwen",
		},
	},
	{
		id: "openrouter-minimax-m3",
		name: "OpenRouter MiniMax M3",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 512_000,
		compat: { ...rabyteCompat, thinkingFormat: "openrouter" },
	},
	{
		id: "openrouter-mimo-v2.5-pro",
		name: "OpenRouter MiMo V2.5 Pro",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		compat: {
			...rabyteCompat,
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "openrouter",
		},
	},
] satisfies NonNullable<ProviderConfig["models"]>;

function envFilePaths(): string[] {
	return [...new Set([join(REPO_ROOT, ".env"), join(process.cwd(), ".env"), join(REPO_ROOT, ".pi", "irab.env")])];
}

function unquoteEnvValue(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1).replaceAll("\\n", "\n").replaceAll('\\"', '"');
	}
	return trimmed;
}

function loadEnvFile(path: string): void {
	if (!existsSync(path)) return;

	for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/u)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
		if (!match) continue;
		const [, key, rawValue] = match;
		if (process.env[key] === undefined) {
			process.env[key] = unquoteEnvValue(rawValue);
		}
	}
}

function loadLocalEnv(): void {
	for (const path of envFilePaths()) {
		loadEnvFile(path);
	}
}

function env(name: string, fallback = ""): string {
	return process.env[name]?.trim() || fallback;
}

function openAIBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/u, "");
	if (trimmed.endsWith("/v1")) return trimmed;
	return `${trimmed}/v1`;
}

function registerRabyteProvider(pi: ExtensionAPI): void {
	const baseUrl = openAIBaseUrl(
		env("IRAB_RABYTE_OPENAI_BASE_URL", env("IRAB_RABYTE_BASE_URL", DEFAULT_RABYTE_BASE_URL)),
	);
	pi.registerProvider("rabyte", {
		name: "Rabyte",
		baseUrl,
		apiKey: "$IRAB_RABYTE_API_KEY",
		api: "openai-completions",
		models: rabyteModels,
	});
}

function getFixturePath(): string {
	return env("IRAB_REPLAY_FIXTURES", DEFAULT_FIXTURE_PATH);
}

function getToolMode(): IrabToolMode {
	return env("IRAB_TOOL_MODE").toLowerCase() === "live" ? "live" : "replay";
}

function numberEnv(name: string, fallback: number): number {
	const value = Number(env(name));
	if (!Number.isFinite(value) || value <= 0) return fallback;
	return value;
}

function liveConfig(): LiveConfig {
	return {
		paipaiBaseUrl: env("IRAB_PAIPAI_BASE_URL"),
		paipaiApiKey: env("IRAB_PAIPAI_API_KEY"),
		paipaiAppAgent: env("IRAB_PAIPAI_APP_AGENT"),
		paipaiSign: env("IRAB_PAIPAI_SIGN"),
		globalDataBaseUrl: env("IRAB_GLOBAL_DATA_BASE_URL"),
		websearchServiceUrl: env("IRAB_WEBSEARCH_SERVICE_URL"),
		xiaosuReaderUrl: env("IRAB_XIAOSU_READER_URL"),
		xiaosuReaderOverseasUrl: env("IRAB_XIAOSU_READER_OVERSEAS_URL"),
		xiaosuReaderAccessKey: env("IRAB_XIAOSU_READER_ACCESS_KEY"),
		toolTimeoutMs: numberEnv("IRAB_TOOL_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
	};
}

function loadReplayFixtures(): ReplayFixtureFile {
	const raw = readFileSync(getFixturePath(), "utf8");
	return JSON.parse(raw) as ReplayFixtureFile;
}

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)));
}

function tokenize(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9\u4e00-\u9fff]+/u)
		.filter((term) => term.length >= 2);
}

function metadataText(metadata: Record<string, unknown>): string {
	return Object.values(metadata)
		.map((value) => {
			if (value === null || value === undefined) return "";
			if (Array.isArray(value)) return value.join(" ");
			return String(value);
		})
		.join(" ");
}

function collectSearchText(record: EvidenceRecord): string {
	return [
		record.source_id,
		record.title,
		record.date,
		record.publisher,
		record.url,
		record.content,
		metadataText(record.metadata),
	]
		.join(" ")
		.toLowerCase();
}

function scoreRecord(record: EvidenceRecord, terms: string[]): number {
	const searchText = collectSearchText(record);
	return terms.reduce((score, term) => (searchText.includes(term) ? score + 1 : score), 0);
}

function searchRecords(records: EvidenceRecord[], query: string, limit: number | undefined): EvidenceRecord[] {
	const terms = tokenize(query);
	const cappedLimit = normalizeLimit(limit);
	const scored = records.map(
		(record): ScoredRecord => ({
			record,
			score: terms.length === 0 ? 1 : scoreRecord(record, terms),
		}),
	);
	const matched = terms.length === 0 ? scored : scored.filter((entry) => entry.score > 0);

	return matched
		.sort((left, right) => {
			if (left.score !== right.score) return right.score - left.score;
			return right.record.date.localeCompare(left.record.date);
		})
		.slice(0, cappedLimit)
		.map((entry) => entry.record);
}

function allRecords(fixtures: ReplayFixtureFile): EvidenceRecord[] {
	return Object.values(fixtures.records).flat();
}

let nextArtifactId = 1;

function allocateArtifactId(): number {
	const id = nextArtifactId;
	nextArtifactId += 1;
	return id;
}

function safeFileName(value: string): string {
	const cleaned = value
		.trim()
		.replace(/[\s/:()]+/gu, "_")
		.replace(/[^a-zA-Z0-9_.\-\u4e00-\u9fff]+/gu, "_")
		.replace(/^_+|_+$/gu, "")
		.slice(0, 120);
	return cleaned || "artifact";
}

function artifactRootDir(): string {
	return env("IRAB_ARTIFACT_DIR", DEFAULT_ARTIFACT_DIR);
}

function createArtifactDir(tool: IrabToolName): string {
	const dir = join(artifactRootDir(), `${Date.now()}-${safeFileName(tool)}-${randomUUID().slice(0, 8)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function csvCell(value: EvidenceCell): string {
	if (value === null) return "";
	const raw = String(value);
	if (!/[",\r\n]/u.test(raw)) return raw;
	return `"${raw.replaceAll('"', '""')}"`;
}

function tableToCsv(table: EvidenceTable): string {
	const lines = [table.columns.map(csvCell).join(",")];
	for (const row of table.rows) {
		lines.push(table.columns.map((column) => csvCell(row[column] ?? "")).join(","));
	}
	return `${lines.join("\n")}\n`;
}

function markdownCell(value: EvidenceCell | number | string): string {
	return String(value ?? "")
		.replaceAll("\n", " ")
		.replaceAll("|", "\\|")
		.trim();
}

function tablePreview(table: EvidenceTable, headRows = 8, tailRows = 2): string {
	const rows = table.rows;
	const columns = table.columns;
	if (columns.length === 0 || rows.length === 0) return "No data";

	const header = ["", ...columns];
	const separator = ["---:", ...columns.map(() => "---")];
	const body =
		rows.length <= headRows + tailRows
			? rows.map((row, index) => ({ row, index }))
			: [
					...rows.slice(0, headRows).map((row, index) => ({ row, index })),
					...rows.slice(-tailRows).map((row, offset) => ({
						row,
						index: rows.length - tailRows + offset,
					})),
				];

	const lines = [
		`[${rows.length} rows x ${columns.length} columns]`,
		"",
		`| ${header.map(markdownCell).join(" | ")} |`,
		`| ${separator.join(" | ")} |`,
	];

	for (let index = 0; index < body.length; index += 1) {
		if (rows.length > headRows + tailRows && index === headRows) {
			lines.push(" ... ");
		}
		const item = body[index];
		lines.push(
			`| ${[item.index, ...columns.map((column) => item.row[column] ?? "")].map(markdownCell).join(" | ")} |`,
		);
	}

	return lines.join("\n").trim();
}

function writeTableFile(table: EvidenceTable, artifactDir: string, id: number, nameHint: string): string {
	const filePath = join(artifactDir, `${safeFileName(`${id}-${nameHint}`)}.csv`);
	writeFileSync(filePath, tableToCsv(table), "utf8");
	return filePath;
}

function isHttpUrl(value: string): boolean {
	return /^https?:\/\//iu.test(value);
}

function extensionFromUrl(url: string): string {
	const parsedExtension = extname(new URL(url).pathname);
	if (parsedExtension && parsedExtension.length <= 8) return parsedExtension;
	return ".png";
}

async function downloadImageFile(
	url: string,
	artifactDir: string,
	id: number,
	title: string,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<string | undefined> {
	if (!isHttpUrl(url)) return undefined;
	const controller = new AbortController();
	const abort = () => controller.abort(signal?.reason);
	const timeout = setTimeout(
		() => controller.abort(new Error(`Image download timed out after ${timeoutMs}ms`)),
		timeoutMs,
	);
	if (signal?.aborted) abort();
	signal?.addEventListener("abort", abort, { once: true });

	try {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) return undefined;
		const data = Buffer.from(await response.arrayBuffer());
		const filePath = join(artifactDir, `${safeFileName(`${id}-${title || "image"}`)}${extensionFromUrl(url)}`);
		writeFileSync(filePath, data);
		return filePath;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
	}
}

function artifactHeader(id: number): string {
	return `[source:${id}]`;
}

function serializeTextArtifact(artifact: TextArtifact): string {
	const contextInfo = firstString(recordValue(artifact.metadata, "context_info"));
	const content =
		contextInfo && !artifact.content.startsWith(contextInfo)
			? `${contextInfo} ${artifact.content}`
			: artifact.content;
	return `${artifactHeader(artifact.id)}${content}`;
}

function serializeImageArtifact(artifact: ImageArtifact): string {
	const src = artifact.filePath || artifact.url;
	const alt = artifact.title ? `Image: ${artifact.title}` : "";
	const description = artifact.description ? `\nImage content: ${artifact.description}` : "";
	return `${artifactHeader(artifact.id)}![${alt}](${src})${description}`;
}

function serializeTableArtifact(artifact: TableArtifact): string {
	return `${artifactHeader(artifact.id)}Source: ${artifact.instSource} File: ${artifact.filePath}\nData preview:\n${artifact.preview.trim()}`;
}

function serializeArtifact(artifact: IrabArtifact): string {
	if (artifact.type === "text") return serializeTextArtifact(artifact);
	if (artifact.type === "image") return serializeImageArtifact(artifact);
	if (artifact.type === "table") return serializeTableArtifact(artifact);
	if (artifact.type === "error") {
		return `${artifactHeader(artifact.id)}${artifact.errorType}: ${artifact.content}`;
	}
	return `${artifactHeader(artifact.id)}${artifact.content}`;
}

function artifactLabel(artifact: IrabArtifact): string {
	return artifactHeader(artifact.id);
}

function artifactDetails(artifact: IrabArtifact): SerializedArtifactDetails {
	const base = {
		id: artifact.id,
		type: artifact.type,
		label: artifactLabel(artifact),
		source: artifact.source,
		metadata: artifact.metadata,
	};
	if (artifact.type === "image") {
		return {
			...base,
			file_path: artifact.filePath,
			url: artifact.url,
			title: artifact.title,
		};
	}
	if (artifact.type === "table") {
		return {
			...base,
			file_path: artifact.filePath,
			title: firstString(recordValue(artifact.metadata, "indicator_name")),
		};
	}
	return base;
}

function buildObservationText(message: string | undefined, artifacts: IrabArtifact[]): string {
	const serializedArtifacts = artifacts.map((artifact) => serializeArtifact(artifact)).join("\n");
	if (message && serializedArtifacts) return `${message}\n${serializedArtifacts}`;
	return message || serializedArtifacts || "";
}

function buildToolResult(details: IrabToolDetailsInput, artifacts: IrabArtifact[]): AgentToolResult<IrabToolDetails> {
	const fullDetails = {
		...details,
		artifacts: artifacts.map((artifact) => artifactDetails(artifact)),
	};

	return {
		content: [{ type: "text", text: buildObservationText(details.message, artifacts) }],
		details: fullDetails,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(record: Record<string, unknown>, key: string): unknown {
	return record[key];
}

function firstString(...values: unknown[]): string {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
		if (typeof value === "number" || typeof value === "boolean") return String(value);
		if (Array.isArray(value)) {
			const joined = value
				.map((item) =>
					typeof item === "string" || typeof item === "number" || typeof item === "boolean" ? String(item) : "",
				)
				.filter(Boolean)
				.join(", ");
			if (joined) return joined;
		}
	}
	return "";
}

function valueToContent(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) {
		return value
			.map((item) => valueToContent(item))
			.filter(Boolean)
			.join("\n\n");
	}
	if (isRecord(value)) {
		return firstString(
			recordValue(value, "content"),
			recordValue(value, "text"),
			recordValue(value, "snippet"),
			recordValue(value, "summary"),
			recordValue(value, "answer"),
			recordValue(value, "chunk"),
			recordValue(value, "chunks"),
		);
	}
	return "";
}

function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter((item) => item.length > 0);
}

function normalizeSourceId(prefix: string, rawId: string, index: number): string {
	const clean = rawId
		.trim()
		.replace(/[^a-zA-Z0-9_.:-]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 120);
	return clean || `${prefix}-${index + 1}`;
}

function truncateContent(content: string): string {
	if (content.length <= 12_000) return content;
	return `${content.slice(0, 12_000)}\n\n[truncated]`;
}

function splitMarkdownRow(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/u, "")
		.replace(/\|$/u, "")
		.split("|")
		.map((cell) => cell.trim());
}

function parseMarkdownTable(content: string): EvidenceTable | null {
	const lines = content.split(/\r?\n/u);
	for (let index = 0; index < lines.length - 1; index += 1) {
		const header = lines[index];
		const separator = lines[index + 1];
		if (!header.includes("|") || !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(separator)) {
			continue;
		}

		const columns = splitMarkdownRow(header);
		const rows: Record<string, EvidenceCell>[] = [];
		for (const rowLine of lines.slice(index + 2)) {
			if (!rowLine.includes("|") || !rowLine.trim()) break;
			const cells = splitMarkdownRow(rowLine);
			if (cells.length !== columns.length) break;
			const row: Record<string, EvidenceCell> = {};
			for (let cellIndex = 0; cellIndex < columns.length; cellIndex += 1) {
				const rawCell = cells[cellIndex];
				const numeric = Number(rawCell.replaceAll(",", ""));
				row[columns[cellIndex]] = Number.isFinite(numeric) && rawCell !== "" ? numeric : rawCell;
			}
			rows.push(row);
		}

		if (columns.length > 0 && rows.length > 0) return { columns, rows };
	}
	return null;
}

function extractItems(payload: unknown, keys: string[]): unknown[] {
	if (Array.isArray(payload)) return payload;
	if (!isRecord(payload)) return [];

	for (const key of keys) {
		const value = recordValue(payload, key);
		if (Array.isArray(value)) return value;
		if (isRecord(value)) {
			const nested = extractItems(value, keys);
			if (nested.length > 0) return nested;
		}
	}
	return [];
}

function nestedRecord(record: Record<string, unknown>, ...keys: string[]): Record<string, unknown> | undefined {
	for (const key of keys) {
		const value = recordValue(record, key);
		if (isRecord(value)) return value;
	}
	return undefined;
}

function recordMetadata(item: unknown): Record<string, unknown> {
	if (isRecord(item)) return item;
	return { value: item };
}

function evidenceFromUnknown(prefix: string, item: unknown, index: number): EvidenceRecord {
	const record = isRecord(item) ? item : {};
	const sourceData = nestedRecord(record, "sourceData", "source_data", "source") ?? {};
	const chunksContent = valueToContent(recordValue(record, "chunks"));
	const dataContent = valueToContent(recordValue(record, "data"));
	const content = truncateContent(
		firstString(
			recordValue(record, "content"),
			recordValue(record, "text"),
			recordValue(record, "snippet"),
			recordValue(record, "summary"),
			recordValue(record, "answer"),
			recordValue(record, "chunk"),
			recordValue(sourceData, "content"),
			recordValue(sourceData, "text"),
			chunksContent,
			dataContent,
		),
	);
	const tableContent = firstString(chunksContent, dataContent, content);
	const title = firstString(
		recordValue(record, "title"),
		recordValue(sourceData, "title"),
		recordValue(record, "name"),
		recordValue(record, "indicator"),
		recordValue(record, "query"),
		content.slice(0, 80),
		"Untitled evidence",
	);
	const rawId = firstString(
		recordValue(record, "source_id"),
		recordValue(record, "sourceId"),
		recordValue(record, "id"),
		recordValue(record, "sub_id"),
		recordValue(sourceData, "id"),
		recordValue(record, "link"),
		recordValue(record, "url"),
		title,
	);
	const url = firstString(recordValue(record, "url"), recordValue(record, "link"), recordValue(sourceData, "url"));
	const date = firstString(
		recordValue(record, "date"),
		recordValue(record, "time"),
		recordValue(record, "publish_time"),
		recordValue(record, "publishTime"),
		recordValue(record, "updated_at"),
		recordValue(record, "report_date"),
	);
	const publisher = firstString(
		recordValue(record, "publisher"),
		recordValue(record, "site_name"),
		recordValue(record, "source"),
		recordValue(record, "institution"),
		recordValue(record, "authors"),
		recordValue(sourceData, "publisher"),
	);

	return {
		source_id: normalizeSourceId(prefix, rawId, index),
		title,
		date,
		publisher,
		url,
		content,
		table: parseMarkdownTable(tableContent),
		metadata: recordMetadata(item),
	};
}

function dedupeSourceIds(records: EvidenceRecord[]): EvidenceRecord[] {
	const seen = new Map<string, number>();
	return records.map((record) => {
		const count = seen.get(record.source_id) ?? 0;
		seen.set(record.source_id, count + 1);
		if (count === 0) return record;
		return { ...record, source_id: `${record.source_id}-${count + 1}` };
	});
}

function normalizePayloadRecords(prefix: string, payload: unknown, limit: number): EvidenceRecord[] {
	const items = extractItems(payload, ["data", "records", "results", "items", "chunks"]);
	const sourceItems = items.length > 0 ? items : isRecord(payload) ? [payload] : [];
	return dedupeSourceIds(sourceItems.map((item, index) => evidenceFromUnknown(prefix, item, index))).slice(0, limit);
}

function payloadDataRecords(payload: unknown): Record<string, unknown>[] {
	if (!isRecord(payload)) return [];
	const data = recordValue(payload, "data");
	if (!Array.isArray(data)) return [];
	return data.filter(isRecord);
}

function markdownTableFromChunks(item: Record<string, unknown>): EvidenceTable | null {
	const chunks = valueToContent(recordValue(item, "chunks"));
	if (!chunks) return null;
	return parseMarkdownTable(chunks);
}

function indicTableName(item: Record<string, unknown>, fallbackIndex: number): string {
	const indicNames = recordValue(item, "indic_names");
	if (Array.isArray(indicNames) && indicNames.length > 0) return firstString(indicNames[0]);
	return `table_${fallbackIndex + 1}`;
}

function mergeTables(left: EvidenceTable, right: EvidenceTable): EvidenceTable {
	const columns = [...left.columns];
	for (const column of right.columns) {
		if (!columns.includes(column)) columns.push(column);
	}
	return {
		columns,
		rows: [...left.rows, ...right.rows],
	};
}

function sortedTableByColumn(table: EvidenceTable, column: string): EvidenceTable {
	return {
		columns: table.columns,
		rows: [...table.rows].sort((left, right) =>
			String(right[column] ?? "").localeCompare(String(left[column] ?? "")),
		),
	};
}

function tableTimeRange(table: EvidenceTable, columns: string[]): { startTime: string; endTime: string } {
	for (const column of columns) {
		if (!table.columns.includes(column)) continue;
		const values = table.rows
			.map((row) => firstString(row[column]))
			.filter(Boolean)
			.sort();
		if (values.length > 0) return { startTime: values[0], endTime: values[values.length - 1] };
	}
	return { startTime: "", endTime: "" };
}

function simpleDataSourceData(item: Record<string, unknown>): Record<string, unknown> {
	const sourceData: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(item)) {
		if (key === "chunks" || key === "content_text" || key === "context_info") continue;
		sourceData[key] = value;
	}
	if (!sourceData.article_id) sourceData.article_id = firstString(recordValue(item, "id"));
	return sourceData;
}

function normalizeSimpleDataRecords(payload: unknown, query: string): EvidenceRecord[] {
	type ProcessedSimpleTable = {
		table: EvidenceTable;
		instSource: string[];
		sourceId: string;
		sourceExpr: string;
		sourceData: Record<string, unknown>;
	};
	const indicatorTables = new Map<string, ProcessedSimpleTable>();
	for (const item of payloadDataRecords(payload)) {
		const table = markdownTableFromChunks(item);
		if (!table) continue;
		const tableName = indicTableName(item, indicatorTables.size);
		const existing = indicatorTables.get(tableName);
		if (existing) {
			existing.table = mergeTables(existing.table, table);
			continue;
		}
		const sourceData = simpleDataSourceData(item);
		const sourceId = firstString(recordValue(item, "id"));
		indicatorTables.set(tableName, {
			table,
			instSource: toStringArray(recordValue(sourceData, "orig_inst_source")),
			sourceId,
			sourceExpr: `edb_${sourceId}`,
			sourceData,
		});
	}

	return [...indicatorTables.entries()].map(([indicatorName, item], index) => {
		const table = item.table.columns.includes("统计日期") ? sortedTableByColumn(item.table, "统计日期") : item.table;
		const { startTime, endTime } = tableTimeRange(table, ["统计日期"]);
		return {
			source_id: normalizeSourceId("cn-marketdata", item.sourceId, index),
			title: indicatorName,
			date: endTime,
			publisher: item.instSource.join("|"),
			url: "",
			content: indicatorName,
			table,
			metadata: {
				query,
				queries: [query],
				indicator_name: indicatorName,
				start_time: startTime,
				end_time: endTime,
				source_id: item.sourceId,
				source_expr: item.sourceExpr,
				source_data: item.sourceData,
				orig_inst_source: item.instSource,
			},
		};
	});
}

function globalDataId(index = 0): string {
	return `${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}_${index}`;
}

function normalizeGlobalDataRecords(payload: unknown, query: string): EvidenceRecord[] {
	const alphaSource = ["「Alpha派」全球数据库"];
	const indicatorTables = new Map<string, EvidenceRecord>();
	for (const [index, item] of payloadDataRecords(payload).entries()) {
		const parsedTable = markdownTableFromChunks(item);
		if (!parsedTable) continue;
		const indicatorName = indicTableName(item, indicatorTables.size);
		const sourceId = globalDataId();
		const sourceData = {
			article_id: sourceId,
			type: "edb",
			id: sourceId,
			origin_id: sourceId,
			indic_names: recordValue(item, "indic_names") ?? [],
			inst_source: alphaSource,
			orig_inst_source: alphaSource,
			publish_date: "",
			chunk: valueToContent(recordValue(item, "chunks")),
			search_type: "global_search",
		};
		let table = parsedTable;
		for (const timeColumn of ["date", "Date", "publishedDate", "fillingDate", "acceptedDate"]) {
			if (table.columns.includes(timeColumn)) {
				table = sortedTableByColumn(table, timeColumn);
				break;
			}
		}
		const { startTime, endTime } = tableTimeRange(table, [
			"date",
			"Date",
			"publishedDate",
			"fillingDate",
			"acceptedDate",
		]);
		indicatorTables.set(indicatorName, {
			source_id: normalizeSourceId("global-data", sourceId, index),
			title: indicatorName,
			date: endTime,
			publisher: alphaSource.join("|"),
			url: "",
			content: indicatorName,
			table,
			metadata: {
				query,
				queries: [query],
				indicator_name: indicatorName,
				start_time: startTime,
				end_time: endTime,
				source_id: sourceId,
				source_expr: `edb_${sourceId}`,
				source_data: sourceData,
				orig_inst_source: alphaSource,
			},
		});
	}
	return [...indicatorTables.values()];
}

function normalizeWebRecords(payload: unknown, limit: number): EvidenceRecord[] {
	const resultItems = extractItems(payload, ["results", "data", "items"]);
	const pages = resultItems.flatMap((item) => {
		const nestedPages = extractItems(item, ["webpages", "pages", "results", "items"]);
		if (nestedPages.length > 0) return nestedPages;
		return isRecord(item) ? [item] : [];
	});
	const sourceItems = pages.length > 0 ? pages : extractItems(payload, ["webpages", "pages"]);
	return dedupeSourceIds(sourceItems.map((item, index) => webEvidenceFromUnknown(item, index))).slice(0, limit);
}

function webEvidenceFromUnknown(item: unknown, index: number): EvidenceRecord {
	const metadata = isRecord(item) ? item : {};
	const title = firstString(recordValue(metadata, "title"), `Web result ${index + 1}`);
	const url = firstString(recordValue(metadata, "link"), recordValue(metadata, "url"));
	const date = firstString(recordValue(metadata, "date"));
	const authors = toStringArray(recordValue(metadata, "authors"));
	const siteName = firstString(
		recordValue(metadata, "siteName"),
		recordValue(metadata, "site_name"),
		recordValue(metadata, "source"),
		recordValue(metadata, "publisher"),
	);
	const snippet = firstString(recordValue(metadata, "snippet"), recordValue(metadata, "summary"));
	const contextParts = [
		title ? `Title: ${title}` : "",
		authors.length > 0 ? `Authors: ${authors.join(", ")}` : "",
		date ? `Date: ${date}` : "",
		url ? `Source: ${url}` : "",
	].filter(Boolean);
	return {
		source_id: normalizeSourceId("web", url || title, index),
		title,
		date,
		publisher: siteName,
		url,
		content: truncateContent(snippet.replaceAll("\n", " ")),
		table: null,
		metadata: {
			...metadata,
			type: "web",
			articleId: url,
			title,
			publish_date: date,
			url,
			authors,
			source: siteName,
			context_info: contextParts.join(" | "),
		},
	};
}

function metadataArrayText(metadata: Record<string, unknown>, key: string): string {
	const value = recordValue(metadata, key);
	if (Array.isArray(value))
		return value
			.map((item) => String(item))
			.filter(Boolean)
			.join("|");
	return firstString(value);
}

function instSourceFromRecord(record: EvidenceRecord): string {
	return (
		metadataArrayText(record.metadata, "orig_inst_source") ||
		metadataArrayText(record.metadata, "inst_source") ||
		metadataArrayText(record.metadata, "source") ||
		record.publisher ||
		"IRaB data"
	);
}

function indicatorNameFromRecord(record: EvidenceRecord): string {
	const indicNames = recordValue(record.metadata, "indic_names");
	if (Array.isArray(indicNames) && indicNames.length > 0) return firstString(indicNames[0]);
	return (
		firstString(
			recordValue(record.metadata, "indicator_name"),
			recordValue(record.metadata, "indicator"),
			recordValue(record.metadata, "name"),
			record.title,
		) || "table"
	);
}

function textArtifactFromRecord(source: string, record: EvidenceRecord): TextArtifact {
	return {
		id: allocateArtifactId(),
		type: "text",
		content: record.content || record.title,
		source,
		metadata: {
			...record.metadata,
			source_id: record.source_id,
			title: record.title,
			publish_date: record.date,
			url: record.url,
			publisher: record.publisher,
		},
	};
}

function tableArtifactFromRecord(
	source: string,
	record: EvidenceRecord,
	artifactDir: string,
): TableArtifact | undefined {
	if (!record.table) return undefined;
	const id = allocateArtifactId();
	const indicatorName = indicatorNameFromRecord(record);
	const instSource = instSourceFromRecord(record);
	const filePath = writeTableFile(record.table, artifactDir, id, `${instSource}-${indicatorName}`);
	return {
		id,
		type: "table",
		source,
		table: record.table,
		filePath,
		instSource,
		preview: tablePreview(record.table),
		metadata: {
			...record.metadata,
			source_id: record.source_id,
			source_expr: firstString(recordValue(record.metadata, "source_expr"), record.source_id),
			indicator_name: indicatorName,
			title: record.title,
			publish_date: record.date,
			url: record.url,
			publisher: record.publisher,
		},
	};
}

function imageUrlFromRecord(record: EvidenceRecord): string {
	const typeText = firstString(recordValue(record.metadata, "type"), recordValue(record.metadata, "original_type"));
	const imageUrl = firstString(
		recordValue(record.metadata, "img_path"),
		recordValue(record.metadata, "image_url"),
		recordValue(record.metadata, "imageUrl"),
		recordValue(record.metadata, "image"),
	);
	if (!imageUrl) return "";
	if (typeText && !/image|img|图/u.test(typeText)) return "";
	return imageUrl;
}

async function imageArtifactFromRecord(
	source: string,
	record: EvidenceRecord,
	artifactDir: string,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<ImageArtifact | undefined> {
	const url = imageUrlFromRecord(record);
	if (!url) return undefined;
	const id = allocateArtifactId();
	const title = firstString(recordValue(record.metadata, "title"), record.title);
	const filePath = await downloadImageFile(url, artifactDir, id, title, signal, timeoutMs);
	return {
		id,
		type: "image",
		source,
		url,
		filePath,
		title,
		description: record.content,
		metadata: {
			...record.metadata,
			source_id: record.source_id,
			title: record.title,
			publish_date: record.date,
			url: record.url,
			publisher: record.publisher,
		},
	};
}

async function artifactsFromRecords(
	tool: IrabToolName,
	records: EvidenceRecord[],
	artifactDir: string,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<IrabArtifact[]> {
	const artifacts: IrabArtifact[] = [];
	const tableTool = tool === "search_global_data" || tool === "search_cn_marketdata";
	for (const record of records) {
		if (tableTool) {
			const tableArtifact = tableArtifactFromRecord(tool, record, artifactDir);
			if (tableArtifact) {
				artifacts.push(tableArtifact);
				continue;
			}
		}

		const imageArtifact =
			tool === "search_paipai"
				? await imageArtifactFromRecord(tool, record, artifactDir, signal, timeoutMs)
				: undefined;
		artifacts.push(imageArtifact ?? textArtifactFromRecord(tool, record));
	}
	return artifacts;
}

function joinUrl(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}

function requireConfig(value: string, label: string): string {
	if (value) return value;
	throw new Error(`${label} is not configured. Set it in ${join(REPO_ROOT, ".env")} or process env.`);
}

function parseJsonResponse(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return { text };
	}
}

async function postJson(
	endpoint: string,
	body: Record<string, unknown>,
	headers: Record<string, string>,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<HttpJsonResult> {
	const controller = new AbortController();
	const abort = () => controller.abort(signal?.reason);
	const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
	if (signal?.aborted) abort();
	signal?.addEventListener("abort", abort, { once: true });

	try {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		const text = await response.text();
		const payload = parseJsonResponse(text);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} from ${endpoint}: ${text.slice(0, 300)}`);
		}
		return { status: response.status, payload };
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
	}
}

async function fetchText(
	url: string,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<{ status: number; text: string }> {
	const controller = new AbortController();
	const abort = () => controller.abort(signal?.reason);
	const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
	if (signal?.aborted) abort();
	signal?.addEventListener("abort", abort, { once: true });

	try {
		const response = await fetch(url, {
			headers: { Accept: "text/html,text/plain,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
			signal: controller.signal,
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 300)}`);
		}
		return { status: response.status, text };
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
	}
}

function paipaiDate(value: string | undefined, endOfDay: boolean): string | undefined {
	if (!value) return undefined;
	if (/\d\d:\d\d:\d\d/u.test(value)) return value;
	return `${value} ${endOfDay ? "23:59:59" : "00:00:00"}`;
}

function searchHeaders(config: LiveConfig): Record<string, string> {
	const headers: Record<string, string> = {};
	if (config.paipaiAppAgent) headers["app-agent"] = config.paipaiAppAgent;
	if (config.paipaiSign) headers.sign = config.paipaiSign;
	if (config.paipaiApiKey) headers.Authorization = config.paipaiApiKey;
	return headers;
}

async function liveSearchPaipai(
	params: SearchExecutionParams,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<IrabToolDetails>> {
	const config = liveConfig();
	const endpoint = joinUrl(requireConfig(config.paipaiBaseUrl, "IRAB_PAIPAI_BASE_URL"), "/paipai_data");
	const limit = normalizeLimit(params.limit);
	const response = await postJson(
		endpoint,
		{
			userId: params.user_id ?? env("IRAB_PAIPAI_USER_ID", "irab-agent"),
			query: params.query,
			article_type: params.sources ?? [],
			isCutOff: true,
			slot_num: limit,
			web_search: false,
			start_time: paipaiDate(params.start_time, false),
			end_time: paipaiDate(params.end_time, true),
			skip_bm25_rank: true,
			skip_query_expansion: true,
			skip_entity_filter: true,
			skip_es_recall: false,
			needSourceData: true,
			needHighlightsExtra: true,
			referenceRangeList: [],
			subscribeAccountIdList: [],
		},
		searchHeaders(config),
		signal,
		config.toolTimeoutMs,
	);
	const results = normalizePayloadRecords("paipai", response.payload, limit);
	return buildLiveSearchResult("search_paipai", params.query, endpoint, results, signal, config.toolTimeoutMs);
}

async function liveSearchGlobalData(
	params: SearchExecutionParams,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<IrabToolDetails>> {
	const config = liveConfig();
	const endpoint = joinUrl(
		requireConfig(config.globalDataBaseUrl, "IRAB_GLOBAL_DATA_BASE_URL"),
		"/global/stable/query",
	);
	const response = await postJson(endpoint, { query: params.query }, {}, signal, config.toolTimeoutMs);
	const results = normalizeGlobalDataRecords(response.payload, params.query);
	return buildLiveSearchResult("search_global_data", params.query, endpoint, results, signal, config.toolTimeoutMs);
}

async function liveSearchCnMarketData(
	params: SearchExecutionParams,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<IrabToolDetails>> {
	const config = liveConfig();
	const endpoint = joinUrl(requireConfig(config.paipaiBaseUrl, "IRAB_PAIPAI_BASE_URL"), "/edb/simple_data");
	const limit = normalizeLimit(params.limit);
	const timeoutSecs = Math.ceil(config.toolTimeoutMs / 1000);
	const response = await postJson(
		endpoint,
		{
			query: params.query,
			top_k: limit,
			timeout_expand: Math.max(1, Math.floor(timeoutSecs / 2)),
			timeout_total: timeoutSecs,
		},
		{},
		signal,
		config.toolTimeoutMs,
	);
	const results = normalizeSimpleDataRecords(response.payload, params.query);
	return buildLiveSearchResult("search_cn_marketdata", params.query, endpoint, results, signal, config.toolTimeoutMs);
}

async function liveSearchWeb(
	params: SearchExecutionParams,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<IrabToolDetails>> {
	const config = liveConfig();
	const endpoint = joinUrl(requireConfig(config.websearchServiceUrl, "IRAB_WEBSEARCH_SERVICE_URL"), "/v1/search");
	const limit = normalizeLimit(params.limit);
	const response = await postJson(
		endpoint,
		{
			queries: [params.query],
			count: limit,
			caller_id: "irab-agent",
			start_time: params.start_time,
			end_time: params.end_time,
			include_domains: params.include_domains,
			exclude_domains: params.exclude_domains,
		},
		{},
		signal,
		config.toolTimeoutMs,
	);
	const results = normalizeWebRecords(response.payload, limit);
	return buildLiveSearchResult("search_web", params.query, endpoint, results, signal, config.toolTimeoutMs);
}

function searchMessage(
	tool: IrabSearchToolName,
	query: string,
	recordCount: number,
	artifactCount: number,
	mode: IrabToolMode,
): string | undefined {
	if (artifactCount === 0) {
		return `No ${mode} evidence matched "${query}". Do not invent citations.`;
	}
	if (tool === "search_paipai") return `Found ${artifactCount} items`;
	if (tool === "search_web") return `Found ${artifactCount} results`;
	if (tool === "search_global_data") {
		return `Successfully fetched ${artifactCount} data table${artifactCount === 1 ? "" : "s"} from ${recordCount} result${recordCount === 1 ? "" : "s"}`;
	}
	return `Got ${artifactCount} table${artifactCount === 1 ? "" : "s"}`;
}

async function buildLiveSearchResult(
	tool: IrabSearchToolName,
	query: string,
	endpoint: string,
	results: EvidenceRecord[],
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<AgentToolResult<IrabToolDetails>> {
	const artifactDir = createArtifactDir(tool);
	const artifacts = await artifactsFromRecords(tool, results, artifactDir, signal, timeoutMs);
	const message = searchMessage(tool, query, results.length, artifacts.length, "live");
	return buildToolResult(
		{
			mode: "live",
			tool,
			query,
			endpoint,
			results,
			artifact_dir: artifactDir,
			message,
		},
		artifacts,
	);
}

function fetchFormat(value: string | undefined): "text" | "html" {
	return value === "html" ? "html" : "text";
}

function isPdfUrl(url: string): boolean {
	return /\.pdf(?:$|[?#])/iu.test(url);
}

function readerEndpoint(config: LiveConfig): string {
	return config.xiaosuReaderUrl || config.xiaosuReaderOverseasUrl;
}

function evidenceFromFetchedContent(
	url: string,
	content: string,
	metadata: Record<string, unknown>,
	status: number,
): EvidenceRecord {
	return {
		source_id: normalizeSourceId("web-fetch", url, 0),
		title: firstString(metadata.title, url),
		date: "",
		publisher: firstString(metadata.reader_type, "web"),
		url,
		content: truncateContent(content),
		table: parseMarkdownTable(content),
		metadata: { ...metadata, status },
	};
}

async function liveFetchWeb(
	url: string,
	format: "text" | "html",
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<IrabToolDetails>> {
	const config = liveConfig();
	const endpoint = readerEndpoint(config);
	if (!endpoint || !config.xiaosuReaderAccessKey) {
		const response = await fetchText(url, signal, config.toolTimeoutMs);
		const artifactDir = createArtifactDir("fetch_web");
		const results = [
			evidenceFromFetchedContent(url, response.text, { reader_type: "direct_fetch" }, response.status),
		];
		const artifacts = await artifactsFromRecords("fetch_web", results, artifactDir, signal, config.toolTimeoutMs);
		return buildToolResult(
			{
				mode: "live",
				tool: "fetch_web",
				query: url,
				endpoint: url,
				results,
				artifact_dir: artifactDir,
				message: "Read successful",
			},
			artifacts,
		);
	}

	const response = await postJson(
		endpoint,
		{
			url,
			formats: [format === "html" ? "HTML" : "TEXT"],
			mode: "auto",
			pdfExtractEnable: isPdfUrl(url),
			enhancedOcr: true,
			timeout: config.toolTimeoutMs,
		},
		{ Authorization: `Bearer ${config.xiaosuReaderAccessKey}` },
		signal,
		config.toolTimeoutMs,
	);
	const payload = isRecord(response.payload) ? response.payload : {};
	const content = firstString(recordValue(payload, "text"), recordValue(payload, "html"));
	const result = evidenceFromFetchedContent(
		url,
		content,
		{
			reader_type: "xiaosu_reader",
			internal_links: toStringArray(recordValue(payload, "internal_links")),
			external_links: toStringArray(recordValue(payload, "external_links")),
		},
		response.status,
	);
	const message = result.content
		? "Read successful"
		: "The reader returned no content. Do not cite this URL for factual claims.";
	const artifactDir = createArtifactDir("fetch_web");
	const results = result.content ? [result] : [];
	const artifacts = await artifactsFromRecords("fetch_web", results, artifactDir, signal, config.toolTimeoutMs);
	return buildToolResult(
		{
			mode: "live",
			tool: "fetch_web",
			query: url,
			endpoint,
			results,
			artifact_dir: artifactDir,
			message,
		},
		artifacts,
	);
}

async function executeSearchTool(
	tool: IrabSearchToolName,
	params: SearchExecutionParams,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<IrabToolDetails>> {
	if (signal?.aborted) throw new Error("IRaB tool call aborted");

	if (getToolMode() === "live") {
		if (tool === "search_paipai") return liveSearchPaipai(params, signal);
		if (tool === "search_global_data") return liveSearchGlobalData(params, signal);
		if (tool === "search_cn_marketdata") return liveSearchCnMarketData(params, signal);
		return liveSearchWeb(params, signal);
	}

	const fixtures = loadReplayFixtures();
	const results = searchRecords(fixtures.records[tool] ?? [], params.query, params.limit);
	const artifactDir = createArtifactDir(tool);
	const artifacts = await artifactsFromRecords(
		tool,
		results,
		artifactDir,
		signal,
		numberEnv("IRAB_TOOL_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
	);
	const message = searchMessage(tool, params.query, results.length, artifacts.length, "replay");

	return buildToolResult(
		{
			mode: "replay",
			tool,
			query: params.query,
			fixture_version: fixtures.version,
			results,
			artifact_dir: artifactDir,
			message,
		},
		artifacts,
	);
}

async function executeFetchWebTool(
	url: string,
	format: "text" | "html",
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<IrabToolDetails>> {
	if (signal?.aborted) throw new Error("IRaB tool call aborted");

	if (getToolMode() === "live") {
		return liveFetchWeb(url, format, signal);
	}

	const fixtures = loadReplayFixtures();
	const results = allRecords(fixtures).filter((record) => record.url === url);
	const artifactDir = createArtifactDir("fetch_web");
	const artifacts = await artifactsFromRecords(
		"fetch_web",
		results,
		artifactDir,
		signal,
		numberEnv("IRAB_TOOL_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
	);
	const message =
		artifacts.length === 0
			? "No replay fixture is available for this URL. Do not invent citations."
			: "Read successful";

	return buildToolResult(
		{
			mode: "replay",
			tool: "fetch_web",
			query: url,
			fixture_version: fixtures.version,
			results,
			artifact_dir: artifactDir,
			message,
		},
		artifacts,
	);
}

const commonSearchParameters = {
	query: Type.String({
		description: "Research query. Include company, ticker, market, event, metric, or date constraints when known.",
	}),
	limit: Type.Optional(Type.Number({ description: "Maximum evidence records to return. Defaults to 5." })),
};

const searchPaipaiParameters = Type.Object({
	...commonSearchParameters,
	sources: Type.Optional(
		Type.Array(Type.String(), {
			description: "Optional PaiPai article types such as ann, report, roadShow, or comment.",
		}),
	),
	start_time: Type.Optional(Type.String({ description: "Optional start date, YYYY-MM-DD." })),
	end_time: Type.Optional(Type.String({ description: "Optional end date, YYYY-MM-DD." })),
	user_id: Type.Optional(Type.String({ description: "Optional user id for PaiPai ACL/context routing." })),
});

const searchPaipaiTool = {
	name: "search_paipai",
	label: "Search PaiPai",
	description: "Search internal investment research evidence such as reports, announcements, notes, and comments.",
	promptSnippet: "Search internal investment research evidence.",
	promptGuidelines: [
		"Use search_paipai for company research, analyst notes, announcements, meeting notes, and internal evidence.",
		"Copy the visible [source:x] marker exactly when citing PaiPai evidence.",
	],
	parameters: searchPaipaiParameters,
	executionMode: "parallel",
	async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
		return executeSearchTool("search_paipai", params, signal);
	},
} satisfies ToolDefinition<typeof searchPaipaiParameters, IrabToolDetails>;

const searchGlobalDataParameters = Type.Object({
	...commonSearchParameters,
	symbols: Type.Optional(
		Type.Array(Type.String(), { description: "Optional tickers or symbols to bias the search." }),
	),
});

const searchGlobalDataTool = {
	name: "search_global_data",
	label: "Search Global Data",
	description: "Search structured global-market data for HK/US equities, indices, ETFs, FX, crypto, and commodities.",
	promptSnippet: "Search global market data evidence.",
	promptGuidelines: [
		"Use search_global_data for HK/US equities, ETFs, indices, FX, crypto, commodities, filings, and global-market metrics.",
		"Cite structured market data with the visible [source:x] marker immediately after the supported number or statement.",
	],
	parameters: searchGlobalDataParameters,
	executionMode: "parallel",
	async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
		const query = [params.query, ...(params.symbols ?? [])].join(" ");
		return executeSearchTool("search_global_data", { ...params, query }, signal);
	},
} satisfies ToolDefinition<typeof searchGlobalDataParameters, IrabToolDetails>;

const searchCnMarketDataParameters = Type.Object({
	...commonSearchParameters,
	indicators: Type.Optional(
		Type.Array(Type.String(), { description: "Optional macro, rate, industry, index, or A-share indicators." }),
	),
});

const searchCnMarketDataTool = {
	name: "search_cn_marketdata",
	label: "Search China Market Data",
	description: "Search China macro, rates, industry, A-share, and domestic index data.",
	promptSnippet: "Search China market data evidence.",
	promptGuidelines: [
		"Use search_cn_marketdata for China macro, rates, industries, A-shares, and domestic index evidence.",
		"Do not cite China market-data values unless their visible [source:x] marker appears in a tool result.",
	],
	parameters: searchCnMarketDataParameters,
	executionMode: "parallel",
	async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
		const query = [params.query, ...(params.indicators ?? [])].join(" ");
		return executeSearchTool("search_cn_marketdata", { ...params, query }, signal);
	},
} satisfies ToolDefinition<typeof searchCnMarketDataParameters, IrabToolDetails>;

const searchWebParameters = Type.Object({
	...commonSearchParameters,
	start_time: Type.Optional(Type.String({ description: "Optional start date for web search, YYYY-MM-DD." })),
	end_time: Type.Optional(Type.String({ description: "Optional end date for web search, YYYY-MM-DD." })),
	include_domains: Type.Optional(Type.Array(Type.String(), { description: "Only search these domains." })),
	exclude_domains: Type.Optional(Type.Array(Type.String(), { description: "Exclude these domains." })),
});

const searchWebTool = {
	name: "search_web",
	label: "Search Web",
	description: "Search public-web evidence when internal evidence is insufficient or public information is required.",
	promptSnippet: "Search public-web evidence.",
	promptGuidelines: [
		"Use search_web for public sources, primary filings, regulator pages, or current public context.",
		"Copy the visible [source:x] marker exactly when citing web evidence.",
		"Use fetch_web before relying on a specific URL when the task requires reading that source directly.",
	],
	parameters: searchWebParameters,
	executionMode: "parallel",
	async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
		return executeSearchTool("search_web", params, signal);
	},
} satisfies ToolDefinition<typeof searchWebParameters, IrabToolDetails>;

const fetchWebParameters = Type.Object({
	url: Type.String({ description: "URL to fetch." }),
	format: Type.Optional(Type.String({ description: "Fetch format: text or html. Defaults to text." })),
});

const fetchWebTool = {
	name: "fetch_web",
	label: "Fetch Web",
	description: "Fetch a specific URL and return normalized evidence for citation.",
	promptSnippet: "Fetch a public URL.",
	promptGuidelines: [
		"Use fetch_web for a URL returned by search_web or supplied in the benchmark task.",
		"Copy the visible [source:x] marker exactly when citing fetched web evidence.",
		"If fetch_web returns no content, say the source is unavailable instead of inventing a citation.",
	],
	parameters: fetchWebParameters,
	executionMode: "parallel",
	async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
		return executeFetchWebTool(params.url, fetchFormat(params.format), signal);
	},
} satisfies ToolDefinition<typeof fetchWebParameters, IrabToolDetails>;

export default function irabFinanceToolsExtension(pi: ExtensionAPI) {
	loadLocalEnv();
	registerRabyteProvider(pi);
	pi.registerTool(searchPaipaiTool);
	pi.registerTool(searchGlobalDataTool);
	pi.registerTool(searchCnMarketDataTool);
	pi.registerTool(searchWebTool);
	pi.registerTool(fetchWebTool);
}
