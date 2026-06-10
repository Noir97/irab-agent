import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ProviderConfig, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_LIMIT = 10;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_BASE_MS = 250;
const MAX_GATEWAY_429_ATTEMPTS = 6;
const MAX_RETRY_DELAY_MS = 2_000;
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DEFAULT_RABYTE_BASE_URL = "https://test-llm.rabyte.cn";
const DEFAULT_IRAB_GATEWAY_BASE_URL = `${DEFAULT_RABYTE_BASE_URL}/irab`;
const DEFAULT_ARTIFACT_DIR = join(REPO_ROOT, "tmp", "irab-artifacts");

type IrabSearchToolName =
	| "search_research_corpus"
	| "search_global_market_data"
	| "search_china_market_data"
	| "search_public_web";
type IrabToolName = IrabSearchToolName | "read_public_webpage";

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

type IrabToolDetails = {
	mode: "gateway";
	tool: IrabToolName;
	query: string;
	results: EvidenceRecord[];
	artifacts: SerializedArtifactDetails[];
	artifact_dir?: string;
	endpoint?: string;
	recording_id?: string;
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
};

type GatewayConfig = {
	baseUrl: string;
	apiKey: string;
	toolTimeoutMs: number;
	toolRetryBaseMs: number;
};

type HttpJsonResult = {
	status: number;
	payload: unknown;
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

function gatewayBaseUrl(): string {
	return env("IRAB_GATEWAY_URL", DEFAULT_IRAB_GATEWAY_BASE_URL);
}

function registerRabyteProvider(pi: ExtensionAPI): void {
	pi.registerProvider("rabyte", {
		name: "IRaB Gateway",
		baseUrl: openAIBaseUrl(gatewayBaseUrl()),
		apiKey: "$IRAB_TOKEN",
		api: "openai-completions",
		models: rabyteModels,
	});
}

function numberEnv(name: string, fallback: number): number {
	const value = Number(env(name));
	if (!Number.isFinite(value) || value <= 0) return fallback;
	return value;
}

function gatewayConfig(): GatewayConfig {
	return {
		baseUrl: openAIBaseUrl(gatewayBaseUrl()),
		apiKey: requireConfig(env("IRAB_TOKEN"), "IRAB_TOKEN"),
		toolTimeoutMs: numberEnv("IRAB_TOOL_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
		toolRetryBaseMs: numberEnv("IRAB_TOOL_RETRY_BASE_MS", DEFAULT_RETRY_BASE_MS),
	};
}

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
	return Math.max(1, Math.trunc(limit));
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

function evidenceCellFromUnknown(value: unknown): EvidenceCell {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
		return value;
	}
	return valueToContent(value);
}

function evidenceTableFromUnknown(value: unknown): EvidenceTable | null {
	if (!isRecord(value)) return null;
	const rawColumns = recordValue(value, "columns");
	const rawRows = recordValue(value, "rows");
	if (!Array.isArray(rawColumns) || !Array.isArray(rawRows)) return null;
	const columns = rawColumns.map((column) => firstString(column)).filter(Boolean);
	if (columns.length === 0) return null;
	const rows: Record<string, EvidenceCell>[] = [];
	for (const rawRow of rawRows) {
		if (!isRecord(rawRow)) continue;
		const row: Record<string, EvidenceCell> = {};
		for (const column of columns) {
			row[column] = evidenceCellFromUnknown(recordValue(rawRow, column));
		}
		rows.push(row);
	}
	if (rows.length === 0) return null;
	return { columns, rows };
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
		table: evidenceTableFromUnknown(recordValue(record, "table")) ?? parseMarkdownTable(tableContent),
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
	const globalDataSource = ["IRaB global market data"];
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
			inst_source: globalDataSource,
			orig_inst_source: globalDataSource,
			publish_date: "",
			chunk: valueToContent(recordValue(item, "chunks")),
			search_type: "global_market_data",
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
			source_id: normalizeSourceId("global-market-data", sourceId, index),
			title: indicatorName,
			date: endTime,
			publisher: globalDataSource.join("|"),
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
				orig_inst_source: globalDataSource,
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
	const tableTool = tool === "search_global_market_data" || tool === "search_china_market_data";
	for (const record of records) {
		if (tableTool) {
			const tableArtifact = tableArtifactFromRecord(tool, record, artifactDir);
			if (tableArtifact) {
				artifacts.push(tableArtifact);
				continue;
			}
		}

		const imageArtifact =
			tool === "search_research_corpus"
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
	retryBaseMs: number,
): Promise<HttpJsonResult> {
	for (let attempt = 1; attempt <= MAX_GATEWAY_429_ATTEMPTS; attempt += 1) {
		if (signal?.aborted) {
			throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
		}

		const controller = new AbortController();
		const abort = () => controller.abort(signal?.reason);
		const timeout = setTimeout(
			() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
		let retryDelayMs: number | undefined;
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
			if (response.ok) return { status: response.status, payload };
			const retryableTokenLimit =
				response.status === 429 &&
				attempt < MAX_GATEWAY_429_ATTEMPTS &&
				(text.includes("IRAB token concurrency limit exceeded") || text.includes("IRAB token QPS limit exceeded"));
			if (retryableTokenLimit) {
				retryDelayMs = Math.min(retryBaseMs * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
			} else {
				throw new Error(`HTTP ${response.status} from ${endpoint}: ${text.slice(0, 300)}`);
			}
		} finally {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
		}

		if (retryDelayMs === undefined) break;
		await new Promise((resolve) => {
			setTimeout(resolve, retryDelayMs);
		});
		if (signal?.aborted) {
			throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
		}
	}
	throw new Error(`HTTP 429 from ${endpoint}: gateway token limit retry budget exhausted`);
}

function gatewayToolEndpoint(config: GatewayConfig, tool: IrabToolName): string {
	return joinUrl(config.baseUrl, `/tools/${tool}`);
}

function gatewayHeaders(config: GatewayConfig): Record<string, string> {
	return { Authorization: `Bearer ${config.apiKey}` };
}

function gatewayResponseRecords(
	tool: IrabToolName,
	payload: unknown,
	query: string,
	limit: number | undefined,
): EvidenceRecord[] {
	const cappedLimit = normalizeLimit(limit);
	const response = isRecord(payload) ? payload : {};
	const records = recordValue(response, "records") ?? recordValue(response, "results");
	if (Array.isArray(records)) {
		return dedupeSourceIds(records.map((item, index) => evidenceFromUnknown(tool, item, index))).slice(
			0,
			cappedLimit,
		);
	}

	const upstreamPayload = recordValue(response, "payload") ?? payload;
	if (tool === "search_global_market_data")
		return normalizeGlobalDataRecords(upstreamPayload, query).slice(0, cappedLimit);
	if (tool === "search_china_market_data")
		return normalizeSimpleDataRecords(upstreamPayload, query).slice(0, cappedLimit);
	if (tool === "search_public_web") return normalizeWebRecords(upstreamPayload, cappedLimit);
	return normalizePayloadRecords(tool, upstreamPayload, cappedLimit);
}

function gatewaySearchRequestBody(params: SearchExecutionParams): Record<string, unknown> {
	const body: Record<string, unknown> = { query: params.query };
	if (params.limit !== undefined) body.limit = params.limit;
	if (params.sources !== undefined) body.sources = params.sources;
	if (params.start_time !== undefined) body.start_time = params.start_time;
	if (params.end_time !== undefined) body.end_time = params.end_time;
	if (params.include_domains !== undefined) body.include_domains = params.include_domains;
	if (params.exclude_domains !== undefined) body.exclude_domains = params.exclude_domains;
	return body;
}

function gatewayResponseMessage(payload: unknown): string | undefined {
	if (!isRecord(payload)) return undefined;
	const message = firstString(recordValue(payload, "message"));
	return message || undefined;
}

function gatewayRecordingId(payload: unknown): string | undefined {
	if (!isRecord(payload)) return undefined;
	const recordingId = firstString(recordValue(payload, "recording_id"), recordValue(payload, "recordingId"));
	return recordingId || undefined;
}

async function gatewaySearchTool(
	tool: IrabSearchToolName,
	params: SearchExecutionParams,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<IrabToolDetails>> {
	const config = gatewayConfig();
	const endpoint = gatewayToolEndpoint(config, tool);
	const response = await postJson(
		endpoint,
		gatewaySearchRequestBody(params),
		gatewayHeaders(config),
		signal,
		config.toolTimeoutMs,
		config.toolRetryBaseMs,
	);
	const results = gatewayResponseRecords(tool, response.payload, params.query, params.limit);
	return buildSearchResult(
		"gateway",
		tool,
		params.query,
		endpoint,
		results,
		signal,
		config.toolTimeoutMs,
		gatewayResponseMessage(response.payload),
		gatewayRecordingId(response.payload),
	);
}

async function gatewayFetchWeb(
	url: string,
	format: "text" | "html",
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<IrabToolDetails>> {
	const config = gatewayConfig();
	const endpoint = gatewayToolEndpoint(config, "read_public_webpage");
	const response = await postJson(
		endpoint,
		{ url, format },
		gatewayHeaders(config),
		signal,
		config.toolTimeoutMs,
		config.toolRetryBaseMs,
	);
	const results = gatewayResponseRecords("read_public_webpage", response.payload, url, DEFAULT_LIMIT);
	const artifactDir = createArtifactDir("read_public_webpage");
	const artifacts = await artifactsFromRecords(
		"read_public_webpage",
		results,
		artifactDir,
		signal,
		config.toolTimeoutMs,
	);
	return buildToolResult(
		{
			mode: "gateway",
			tool: "read_public_webpage",
			query: url,
			endpoint,
			results,
			artifact_dir: artifactDir,
			recording_id: gatewayRecordingId(response.payload),
			message:
				gatewayResponseMessage(response.payload) ??
				(results.length === 0 ? "No gateway evidence matched this URL." : "Read successful"),
		},
		artifacts,
	);
}

function searchMessage(
	tool: IrabSearchToolName,
	query: string,
	recordCount: number,
	artifactCount: number,
	mode: "gateway",
): string | undefined {
	if (artifactCount === 0) {
		return `No ${mode} evidence matched "${query}". Do not invent citations.`;
	}
	if (tool === "search_research_corpus") return `Found ${artifactCount} items`;
	if (tool === "search_public_web") return `Found ${artifactCount} results`;
	if (tool === "search_global_market_data") {
		return `Successfully fetched ${artifactCount} data table${artifactCount === 1 ? "" : "s"} from ${recordCount} result${recordCount === 1 ? "" : "s"}`;
	}
	return `Got ${artifactCount} table${artifactCount === 1 ? "" : "s"}`;
}

async function buildSearchResult(
	mode: "gateway",
	tool: IrabSearchToolName,
	query: string,
	endpoint: string,
	results: EvidenceRecord[],
	signal: AbortSignal | undefined,
	timeoutMs: number,
	messageOverride?: string,
	recordingId?: string,
): Promise<AgentToolResult<IrabToolDetails>> {
	const artifactDir = createArtifactDir(tool);
	const artifacts = await artifactsFromRecords(tool, results, artifactDir, signal, timeoutMs);
	const message = messageOverride ?? searchMessage(tool, query, results.length, artifacts.length, mode);
	return buildToolResult(
		{
			mode,
			tool,
			query,
			endpoint,
			results,
			artifact_dir: artifactDir,
			recording_id: recordingId,
			message,
		},
		artifacts,
	);
}

function fetchFormat(value: string | undefined): "text" | "html" {
	return value === "html" ? "html" : "text";
}

async function executeSearchTool(
	tool: IrabSearchToolName,
	params: SearchExecutionParams,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<IrabToolDetails>> {
	if (signal?.aborted) throw new Error("IRaB tool call aborted");

	return gatewaySearchTool(tool, params, signal);
}

async function executeFetchWebTool(
	url: string,
	format: "text" | "html",
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<IrabToolDetails>> {
	if (signal?.aborted) throw new Error("IRaB tool call aborted");

	return gatewayFetchWeb(url, format, signal);
}

const commonSearchParameters = {
	query: Type.String({
		description: "Research query. Include company, ticker, market, event, metric, or date constraints when known.",
	}),
	limit: Type.Optional(Type.Number({ description: "Maximum evidence records to return. Defaults to 10." })),
};

const searchResearchCorpusParameters = Type.Object({
	...commonSearchParameters,
	sources: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Optional corpus source filters such as ann, report, roadShow, comment, or other approved source types.",
		}),
	),
	start_time: Type.Optional(Type.String({ description: "Optional start date, YYYY-MM-DD." })),
	end_time: Type.Optional(Type.String({ description: "Optional end date, YYYY-MM-DD." })),
});

const searchResearchCorpusTool = {
	name: "search_research_corpus",
	label: "Search Research Corpus",
	description:
		"Semantic search over an approved unstructured investment-research corpus, including reports, announcements, meeting notes, commentary, and authorized user-provided materials.",
	promptSnippet: "Semantic search over the unstructured investment-research corpus.",
	promptGuidelines: [
		"Use search_research_corpus for fragmented financial facts or opinions in reports, announcements, meeting notes, commentary, and authorized user-provided materials.",
		"Copy the visible [source:x] marker exactly when citing corpus evidence.",
	],
	parameters: searchResearchCorpusParameters,
	executionMode: "parallel",
	async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
		return executeSearchTool("search_research_corpus", params, signal);
	},
} satisfies ToolDefinition<typeof searchResearchCorpusParameters, IrabToolDetails>;

const searchGlobalDataParameters = Type.Object({
	...commonSearchParameters,
	symbols: Type.Optional(
		Type.Array(Type.String(), { description: "Optional tickers or symbols to bias the search." }),
	),
});

const searchGlobalDataTool = {
	name: "search_global_market_data",
	label: "Search Global Market Data",
	description: "Search structured global-market data for HK/US equities, indices, ETFs, FX, crypto, and commodities.",
	promptSnippet: "Search global market data evidence.",
	promptGuidelines: [
		"Use search_global_market_data for HK/US equities, ETFs, indices, FX, crypto, commodities, filings, and global-market metrics.",
		"Cite structured market data with the visible [source:x] marker immediately after the supported number or statement.",
	],
	parameters: searchGlobalDataParameters,
	executionMode: "parallel",
	async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
		const query = [params.query, ...(params.symbols ?? [])].join(" ");
		return executeSearchTool("search_global_market_data", { ...params, query }, signal);
	},
} satisfies ToolDefinition<typeof searchGlobalDataParameters, IrabToolDetails>;

const searchCnMarketDataParameters = Type.Object({
	...commonSearchParameters,
	indicators: Type.Optional(
		Type.Array(Type.String(), { description: "Optional macro, rate, industry, index, or A-share indicators." }),
	),
});

const searchCnMarketDataTool = {
	name: "search_china_market_data",
	label: "Search China Market Data",
	description: "Search China macro, rates, industry, A-share, and domestic index data.",
	promptSnippet: "Search China market data evidence.",
	promptGuidelines: [
		"Use search_china_market_data for China macro, rates, industries, A-shares, and domestic index evidence.",
		"Do not cite China market-data values unless their visible [source:x] marker appears in a tool result.",
	],
	parameters: searchCnMarketDataParameters,
	executionMode: "parallel",
	async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
		const query = [params.query, ...(params.indicators ?? [])].join(" ");
		return executeSearchTool("search_china_market_data", { ...params, query }, signal);
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
	name: "search_public_web",
	label: "Search Public Web",
	description:
		"Search public-web evidence when corpus or market-data evidence is insufficient or public information is required.",
	promptSnippet: "Search public-web evidence.",
	promptGuidelines: [
		"Use search_public_web for public sources, primary filings, regulator pages, or current public context.",
		"Copy the visible [source:x] marker exactly when citing web evidence.",
		"Use read_public_webpage before relying on a specific URL when the task requires reading that source directly.",
	],
	parameters: searchWebParameters,
	executionMode: "parallel",
	async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
		return executeSearchTool("search_public_web", params, signal);
	},
} satisfies ToolDefinition<typeof searchWebParameters, IrabToolDetails>;

const fetchWebParameters = Type.Object({
	url: Type.String({ description: "URL to fetch." }),
	format: Type.Optional(Type.String({ description: "Fetch format: text or html. Defaults to text." })),
});

const fetchWebTool = {
	name: "read_public_webpage",
	label: "Read Public Webpage",
	description: "Fetch a specific URL and return normalized evidence for citation.",
	promptSnippet: "Fetch a public URL.",
	promptGuidelines: [
		"Use read_public_webpage for a URL returned by search_public_web or supplied in the benchmark task.",
		"Copy the visible [source:x] marker exactly when citing fetched web evidence.",
		"If read_public_webpage returns no content, say the source is unavailable instead of inventing a citation.",
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
	pi.registerTool(searchResearchCorpusTool);
	pi.registerTool(searchGlobalDataTool);
	pi.registerTool(searchCnMarketDataTool);
	pi.registerTool(searchWebTool);
	pi.registerTool(fetchWebTool);
}
