import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
	evidenceFromFetchedContent,
	normalizeGlobalDataRecords,
	normalizePayloadRecords,
	normalizeSimpleDataRecords,
	normalizeWebRecords,
} from "./evidence.ts";
import type {
	EvidenceRecord,
	GatewayState,
	GatewayTokenRecord,
	GatewayToolResponse,
	IrabGatewayConfig,
	IrabSearchToolName,
	IrabToolName,
	SourceConfig,
	TokenApplication,
	TokenQuota,
	TokenScopes,
} from "./types.ts";

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type RuntimeQuota = {
	timestamps: number[];
	inFlight: number;
};

type AuthContext = {
	token: GatewayTokenRecord;
	runtime: RuntimeQuota;
};

type ToolExecutionResult = {
	query: string;
	records: EvidenceRecord[];
	message?: string;
	upstream: {
		endpoint: string;
		payload: unknown;
	};
};

type PartialGatewayConfig = Partial<Omit<IrabGatewayConfig, "defaultQuota" | "source">> & {
	defaultQuota?: Partial<TokenQuota>;
	source?: Partial<SourceConfig>;
};

type IrabGatewayServerOptions = {
	config?: PartialGatewayConfig;
	fetchImpl?: FetchImpl;
	now?: () => number;
};

type JsonResponse = Record<string, unknown> | unknown[];

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DEFAULT_RABYTE_BASE_URL = "https://test-llm.rabyte.cn";
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const TOOL_NAMES = ["search_paipai", "search_global_data", "search_cn_marketdata", "search_web", "fetch_web"] as const;

class GatewayHttpError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function env(name: string, fallback = ""): string {
	return process.env[name]?.trim() || fallback;
}

function numberEnv(name: string, fallback: number): number {
	const value = Number(env(name));
	if (!Number.isFinite(value) || value <= 0) return fallback;
	return value;
}

function booleanEnv(name: string, fallback: boolean): boolean {
	const value = env(name).toLowerCase();
	if (!value) return fallback;
	return value === "1" || value === "true" || value === "yes";
}

function sourceEnv(primary: string, fallback: string): string {
	return env(primary, env(fallback));
}

function defaultSourceConfig(): SourceConfig {
	return {
		paipaiBaseUrl: sourceEnv("PAIPAI_BASE_URL", "IRAB_PAIPAI_BASE_URL"),
		paipaiApiKey: sourceEnv("PAIPAI_API_KEY", "IRAB_PAIPAI_API_KEY"),
		paipaiAppAgent: sourceEnv("PAIPAI_APP_AGENT", "IRAB_PAIPAI_APP_AGENT"),
		paipaiSign: sourceEnv("PAIPAI_SIGN", "IRAB_PAIPAI_SIGN"),
		paipaiUserId: sourceEnv("PAIPAI_USER_ID", "IRAB_PAIPAI_USER_ID") || "irab-gateway",
		globalDataBaseUrl: sourceEnv("GLOBAL_DATA_BASE_URL", "IRAB_GLOBAL_DATA_BASE_URL"),
		websearchServiceUrl: sourceEnv("WEBSEARCH_SERVICE_URL", "IRAB_WEBSEARCH_SERVICE_URL"),
		xiaosuReaderUrl: sourceEnv("XIAOSU_READER_URL", "IRAB_XIAOSU_READER_URL"),
		xiaosuReaderOverseasUrl: sourceEnv("XIAOSU_READER_OVERSEAS_URL", "IRAB_XIAOSU_READER_OVERSEAS_URL"),
		xiaosuReaderAccessKey: sourceEnv("XIAOSU_READER_ACCESS_KEY", "IRAB_XIAOSU_READER_ACCESS_KEY"),
		rabyteBaseUrl: sourceEnv("RABYTE_BASE_URL", "IRAB_RABYTE_BASE_URL") || DEFAULT_RABYTE_BASE_URL,
		rabyteApiKey: sourceEnv("RABYTE_API_KEY", "IRAB_RABYTE_API_KEY"),
	};
}

function mergeConfig(overrides?: PartialGatewayConfig): IrabGatewayConfig {
	const defaultQuota = {
		qps: numberEnv("IRAB_GATEWAY_DEFAULT_QPS", 2),
		concurrency: numberEnv("IRAB_GATEWAY_DEFAULT_CONCURRENCY", 2),
		totalRequests: numberEnv("IRAB_GATEWAY_DEFAULT_TOTAL_REQUESTS", 1_000),
	};
	const source = defaultSourceConfig();
	return {
		port: numberEnv("IRAB_GATEWAY_PORT", 7331),
		adminToken: env("IRAB_GATEWAY_ADMIN_TOKEN"),
		statePath: env("IRAB_GATEWAY_STATE_PATH", join(REPO_ROOT, "tmp", "irab-gateway", "state.json")),
		auditPath: env("IRAB_GATEWAY_AUDIT_PATH", join(REPO_ROOT, "tmp", "irab-gateway", "audit.jsonl")),
		recordingDir: env("IRAB_GATEWAY_RECORDING_DIR", join(REPO_ROOT, "tmp", "irab-recordings", "raw")),
		recordRawTools: booleanEnv("IRAB_GATEWAY_RECORD_RAW", false),
		toolTimeoutMs: numberEnv("IRAB_GATEWAY_TOOL_TIMEOUT_MS", DEFAULT_TOOL_TIMEOUT_MS),
		...overrides,
		defaultQuota: { ...defaultQuota, ...overrides?.defaultQuota },
		source: { ...source, ...overrides?.source },
	};
}

function ensureParent(path: string): void {
	mkdirSync(dirname(path), { recursive: true });
}

function loadState(path: string): GatewayState {
	if (!existsSync(path)) return { applications: [], tokens: [] };
	const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	if (!isRecord(parsed)) return { applications: [], tokens: [] };
	const applications = Array.isArray(parsed.applications) ? parsed.applications.filter(isTokenApplication) : [];
	const tokens = Array.isArray(parsed.tokens) ? parsed.tokens.filter(isGatewayTokenRecord) : [];
	return { applications, tokens };
}

function saveState(path: string, state: GatewayState): void {
	ensureParent(path);
	writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function appendAudit(path: string, event: Record<string, unknown>): void {
	ensureParent(path);
	appendFileSync(path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(record: Record<string, unknown>, key: string): unknown {
	return record[key];
}

function stringField(record: Record<string, unknown>, key: string): string {
	const value = recordValue(record, key);
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
	const value = recordValue(record, key);
	if (!Array.isArray(value)) return [];
	return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

function toolArrayField(record: Record<string, unknown>, key: string): IrabToolName[] {
	return stringArrayField(record, key).filter(isIrabToolName);
}

function isIrabToolName(value: string): value is IrabToolName {
	return TOOL_NAMES.includes(value as IrabToolName);
}

function isTokenApplication(value: unknown): value is TokenApplication {
	if (!isRecord(value)) return false;
	return typeof value.id === "string" && typeof value.status === "string";
}

function isGatewayTokenRecord(value: unknown): value is GatewayTokenRecord {
	if (!isRecord(value)) return false;
	return typeof value.id === "string" && typeof value.tokenHash === "string" && typeof value.status === "string";
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return { text };
	}
}

function parseJsonObject(text: string): Record<string, unknown> {
	if (!text.trim()) return {};
	const parsed = parseJson(text);
	if (!isRecord(parsed)) throw new GatewayHttpError(400, "Expected a JSON object request body");
	return parsed;
}

function readRequestText(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
		});
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});
}

function sendJson(response: ServerResponse, status: number, payload: JsonResponse): void {
	response.writeHead(status, { "Content-Type": "application/json" });
	response.end(`${JSON.stringify(payload)}\n`);
}

function bearerToken(request: IncomingMessage): string {
	const authorization = request.headers.authorization ?? "";
	const match = /^Bearer\s+(.+)$/iu.exec(authorization);
	return match?.[1]?.trim() ?? "";
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left, "hex");
	const rightBuffer = Buffer.from(right, "hex");
	if (leftBuffer.length !== rightBuffer.length) return false;
	return timingSafeEqual(leftBuffer, rightBuffer);
}

function createEvaluatorToken(): string {
	return `irab_${randomBytes(32).toString("base64url")}`;
}

function defaultScopes(application: TokenApplication | undefined): TokenScopes {
	return {
		tools: application?.toolScope.length ? application.toolScope : [...TOOL_NAMES],
		models: application?.modelScope ?? [],
		taskIds: application?.taskSet ? [application.taskSet] : [],
	};
}

function quotaFromBody(body: Record<string, unknown>, fallback: TokenQuota): TokenQuota {
	const quota = isRecord(recordValue(body, "quota")) ? recordValue(body, "quota") : {};
	const record = isRecord(quota) ? quota : {};
	return {
		qps: Math.max(1, Number(recordValue(record, "qps")) || fallback.qps),
		concurrency: Math.max(1, Number(recordValue(record, "concurrency")) || fallback.concurrency),
		totalRequests: Math.max(1, Number(recordValue(record, "totalRequests")) || fallback.totalRequests),
	};
}

function scopesFromBody(body: Record<string, unknown>, fallback: TokenScopes): TokenScopes {
	const scopes = isRecord(recordValue(body, "scopes")) ? recordValue(body, "scopes") : {};
	const record = isRecord(scopes) ? scopes : {};
	const tools = toolArrayField(record, "tools");
	const models = stringArrayField(record, "models");
	const taskIds = stringArrayField(record, "taskIds");
	return {
		tools: tools.length ? tools : fallback.tools,
		models: models.length ? models : fallback.models,
		taskIds: taskIds.length ? taskIds : fallback.taskIds,
	};
}

function taskIdFromRequest(request: IncomingMessage, body: Record<string, unknown>): string {
	const headerValue = request.headers["x-irab-task-id"];
	if (typeof headerValue === "string" && headerValue.trim()) return headerValue.trim();
	const metadata = recordValue(body, "metadata");
	if (isRecord(metadata)) {
		const metadataTaskId = stringField(metadata, "task_id") || stringField(metadata, "taskId");
		if (metadataTaskId) return metadataTaskId;
	}
	return stringField(body, "task_id") || stringField(body, "taskId");
}

function authenticateEvaluator(state: GatewayState, request: IncomingMessage, nowMs: number): AuthContext {
	const token = bearerToken(request);
	if (!token) throw new GatewayHttpError(401, "Missing IRAB bearer token");
	const tokenHash = sha256(token);
	const tokenRecord = state.tokens.find((entry) => safeEqual(entry.tokenHash, tokenHash));
	if (!tokenRecord || tokenRecord.status !== "active") throw new GatewayHttpError(401, "Invalid IRAB token");
	if (Date.parse(tokenRecord.expiresAt) <= nowMs) throw new GatewayHttpError(401, "Expired IRAB token");
	return {
		token: tokenRecord,
		runtime: getRuntimeQuota(tokenRecord.id),
	};
}

const runtimeQuotas = new Map<string, RuntimeQuota>();

function getRuntimeQuota(tokenId: string): RuntimeQuota {
	const existing = runtimeQuotas.get(tokenId);
	if (existing) return existing;
	const runtime = { timestamps: [], inFlight: 0 };
	runtimeQuotas.set(tokenId, runtime);
	return runtime;
}

function enterQuota(
	state: GatewayState,
	config: IrabGatewayConfig,
	auth: AuthContext,
	kind: "model" | "tool",
	resource: string,
	taskId: string,
	nowMs: number,
): () => void {
	const token = auth.token;
	if (kind === "tool" && !token.scopes.tools.includes(resource as IrabToolName)) {
		throw new GatewayHttpError(403, `Token is not scoped for tool ${resource}`);
	}
	if (
		kind === "model" &&
		resource !== "__model_list__" &&
		token.scopes.models.length > 0 &&
		!token.scopes.models.includes(resource)
	) {
		throw new GatewayHttpError(403, `Token is not scoped for model ${resource}`);
	}
	if (taskId && token.scopes.taskIds.length > 0 && !token.scopes.taskIds.includes(taskId)) {
		throw new GatewayHttpError(403, `Token is not scoped for task ${taskId}`);
	}

	auth.runtime.timestamps = auth.runtime.timestamps.filter((timestamp) => timestamp > nowMs - 1_000);
	if (auth.runtime.timestamps.length >= token.quota.qps)
		throw new GatewayHttpError(429, "IRAB token QPS limit exceeded");
	if (auth.runtime.inFlight >= token.quota.concurrency) {
		throw new GatewayHttpError(429, "IRAB token concurrency limit exceeded");
	}
	if (token.usage.totalRequests >= token.quota.totalRequests) {
		throw new GatewayHttpError(429, "IRAB token total request quota exceeded");
	}

	auth.runtime.timestamps.push(nowMs);
	auth.runtime.inFlight += 1;
	token.usage.totalRequests += 1;
	saveState(config.statePath, state);
	return () => {
		auth.runtime.inFlight = Math.max(0, auth.runtime.inFlight - 1);
	};
}

function requireAdmin(config: IrabGatewayConfig, request: IncomingMessage): void {
	if (!config.adminToken) throw new GatewayHttpError(503, "IRAB_GATEWAY_ADMIN_TOKEN is not configured");
	if (bearerToken(request) !== config.adminToken) throw new GatewayHttpError(401, "Invalid admin token");
}

function joinUrl(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}

function openAIBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/u, "");
	if (trimmed.endsWith("/v1")) return trimmed;
	return `${trimmed}/v1`;
}

function requireConfig(value: string, label: string): string {
	if (value) return value;
	throw new GatewayHttpError(503, `${label} is not configured on the IRAB gateway`);
}

async function postJson(
	fetchImpl: FetchImpl,
	endpoint: string,
	body: Record<string, unknown>,
	headers: Record<string, string>,
): Promise<{ status: number; payload: unknown }> {
	const response = await fetchImpl(endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	const payload = parseJson(text);
	if (!response.ok) {
		throw new GatewayHttpError(502, `Upstream HTTP ${response.status} from ${endpoint}: ${text.slice(0, 300)}`);
	}
	return { status: response.status, payload };
}

function searchHeaders(source: SourceConfig): Record<string, string> {
	const headers: Record<string, string> = {};
	if (source.paipaiAppAgent) headers["app-agent"] = source.paipaiAppAgent;
	if (source.paipaiSign) headers.sign = source.paipaiSign;
	if (source.paipaiApiKey) headers.Authorization = source.paipaiApiKey;
	return headers;
}

function normalizeLimit(limit: unknown): number {
	const value = Number(limit);
	if (!Number.isFinite(value) || value <= 0) return 5;
	return Math.max(1, Math.min(10, Math.trunc(value)));
}

function paipaiDate(value: unknown, endOfDay: boolean): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	if (/\d\d:\d\d:\d\d/u.test(value)) return value;
	return `${value} ${endOfDay ? "23:59:59" : "00:00:00"}`;
}

function optionalStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

async function executeSearchPaipai(
	fetchImpl: FetchImpl,
	config: IrabGatewayConfig,
	body: Record<string, unknown>,
): Promise<ToolExecutionResult> {
	const source = config.source;
	const endpoint = joinUrl(requireConfig(source.paipaiBaseUrl, "PAIPAI_BASE_URL"), "/paipai_data");
	const query = requireConfig(stringField(body, "query"), "query");
	const limit = normalizeLimit(recordValue(body, "limit"));
	const response = await postJson(
		fetchImpl,
		endpoint,
		{
			userId: stringField(body, "user_id") || source.paipaiUserId,
			query,
			article_type: optionalStringArray(recordValue(body, "sources")),
			isCutOff: true,
			slot_num: limit,
			web_search: false,
			start_time: paipaiDate(recordValue(body, "start_time"), false),
			end_time: paipaiDate(recordValue(body, "end_time"), true),
			skip_bm25_rank: true,
			skip_query_expansion: true,
			skip_entity_filter: true,
			skip_es_recall: false,
			needSourceData: true,
			needHighlightsExtra: true,
			referenceRangeList: [],
			subscribeAccountIdList: [],
		},
		searchHeaders(source),
	);
	const records = normalizePayloadRecords("paipai", response.payload, limit);
	return {
		query,
		records,
		message: searchMessage("search_paipai", query, records.length),
		upstream: { endpoint, payload: response.payload },
	};
}

async function executeSearchGlobalData(
	fetchImpl: FetchImpl,
	config: IrabGatewayConfig,
	body: Record<string, unknown>,
): Promise<ToolExecutionResult> {
	const endpoint = joinUrl(
		requireConfig(config.source.globalDataBaseUrl, "GLOBAL_DATA_BASE_URL"),
		"/global/stable/query",
	);
	const query = requireConfig(stringField(body, "query"), "query");
	const response = await postJson(fetchImpl, endpoint, { query }, {});
	const records = normalizeGlobalDataRecords(response.payload, query);
	return {
		query,
		records,
		message: searchMessage("search_global_data", query, records.length),
		upstream: { endpoint, payload: response.payload },
	};
}

async function executeSearchCnMarketData(
	fetchImpl: FetchImpl,
	config: IrabGatewayConfig,
	body: Record<string, unknown>,
): Promise<ToolExecutionResult> {
	const endpoint = joinUrl(requireConfig(config.source.paipaiBaseUrl, "PAIPAI_BASE_URL"), "/edb/simple_data");
	const query = requireConfig(stringField(body, "query"), "query");
	const limit = normalizeLimit(recordValue(body, "limit"));
	const timeoutSecs = Math.ceil(config.toolTimeoutMs / 1000);
	const response = await postJson(
		fetchImpl,
		endpoint,
		{
			query,
			top_k: limit,
			timeout_expand: Math.max(1, Math.floor(timeoutSecs / 2)),
			timeout_total: timeoutSecs,
		},
		{},
	);
	const records = normalizeSimpleDataRecords(response.payload, query);
	return {
		query,
		records,
		message: searchMessage("search_cn_marketdata", query, records.length),
		upstream: { endpoint, payload: response.payload },
	};
}

async function executeSearchWeb(
	fetchImpl: FetchImpl,
	config: IrabGatewayConfig,
	body: Record<string, unknown>,
): Promise<ToolExecutionResult> {
	const endpoint = joinUrl(requireConfig(config.source.websearchServiceUrl, "WEBSEARCH_SERVICE_URL"), "/v1/search");
	const query = requireConfig(stringField(body, "query"), "query");
	const limit = normalizeLimit(recordValue(body, "limit"));
	const response = await postJson(
		fetchImpl,
		endpoint,
		{
			queries: [query],
			count: limit,
			caller_id: "irab-gateway",
			start_time: stringField(body, "start_time") || undefined,
			end_time: stringField(body, "end_time") || undefined,
			include_domains: optionalStringArray(recordValue(body, "include_domains")),
			exclude_domains: optionalStringArray(recordValue(body, "exclude_domains")),
		},
		{},
	);
	const records = normalizeWebRecords(response.payload, limit);
	return {
		query,
		records,
		message: searchMessage("search_web", query, records.length),
		upstream: { endpoint, payload: response.payload },
	};
}

function isPdfUrl(url: string): boolean {
	return /\.pdf(?:$|[?#])/iu.test(url);
}

async function executeFetchWeb(
	fetchImpl: FetchImpl,
	config: IrabGatewayConfig,
	body: Record<string, unknown>,
): Promise<ToolExecutionResult> {
	const source = config.source;
	const url = requireConfig(stringField(body, "url"), "url");
	const format = stringField(body, "format") === "html" ? "html" : "text";
	const readerEndpoint = source.xiaosuReaderUrl || source.xiaosuReaderOverseasUrl;
	if (!readerEndpoint || !source.xiaosuReaderAccessKey) {
		const response = await fetchImpl(url, {
			headers: { Accept: "text/html,text/plain,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
		});
		const text = await response.text();
		if (!response.ok)
			throw new GatewayHttpError(502, `Upstream HTTP ${response.status} from ${url}: ${text.slice(0, 300)}`);
		const records = [evidenceFromFetchedContent(url, text, { reader_type: "direct_fetch" }, response.status)];
		return { query: url, records, message: "Read successful", upstream: { endpoint: url, payload: { text } } };
	}

	const response = await postJson(
		fetchImpl,
		readerEndpoint,
		{
			url,
			formats: [format === "html" ? "HTML" : "TEXT"],
			mode: "auto",
			pdfExtractEnable: isPdfUrl(url),
			enhancedOcr: true,
			timeout: config.toolTimeoutMs,
		},
		{ Authorization: `Bearer ${source.xiaosuReaderAccessKey}` },
	);
	const payload = isRecord(response.payload) ? response.payload : {};
	const content = stringField(payload, "text") || stringField(payload, "html");
	const record = evidenceFromFetchedContent(
		url,
		content,
		{
			reader_type: "xiaosu_reader",
			internal_links: optionalStringArray(recordValue(payload, "internal_links")),
			external_links: optionalStringArray(recordValue(payload, "external_links")),
		},
		response.status,
	);
	const records = record.content ? [record] : [];
	const message = record.content
		? "Read successful"
		: "The reader returned no content. Do not cite this URL for factual claims.";
	return { query: url, records, message, upstream: { endpoint: readerEndpoint, payload: response.payload } };
}

function searchMessage(tool: IrabSearchToolName, query: string, recordCount: number): string {
	if (recordCount === 0) return `No gateway evidence matched "${query}". Do not invent citations.`;
	if (tool === "search_paipai") return `Found ${recordCount} item${recordCount === 1 ? "" : "s"}`;
	if (tool === "search_web") return `Found ${recordCount} result${recordCount === 1 ? "" : "s"}`;
	if (tool === "search_global_data")
		return `Successfully fetched ${recordCount} data table${recordCount === 1 ? "" : "s"}`;
	return `Got ${recordCount} table${recordCount === 1 ? "" : "s"}`;
}

async function executeTool(
	tool: IrabToolName,
	fetchImpl: FetchImpl,
	config: IrabGatewayConfig,
	body: Record<string, unknown>,
): Promise<ToolExecutionResult> {
	if (tool === "search_paipai") return executeSearchPaipai(fetchImpl, config, body);
	if (tool === "search_global_data") return executeSearchGlobalData(fetchImpl, config, body);
	if (tool === "search_cn_marketdata") return executeSearchCnMarketData(fetchImpl, config, body);
	if (tool === "search_web") return executeSearchWeb(fetchImpl, config, body);
	return executeFetchWeb(fetchImpl, config, body);
}

function recordRawToolCall(
	config: IrabGatewayConfig,
	token: GatewayTokenRecord,
	tool: IrabToolName,
	requestBody: Record<string, unknown>,
	result: ToolExecutionResult,
): string | undefined {
	if (!config.recordRawTools) return undefined;
	const id = `${Date.now()}-${randomUUID()}`;
	mkdirSync(config.recordingDir, { recursive: true });
	const path = join(config.recordingDir, `${id}.json`);
	writeFileSync(
		path,
		`${JSON.stringify(
			{
				recording_id: id,
				token_id: token.id,
				evaluator_id: token.evaluatorId,
				organization: token.organization,
				tool,
				request: requestBody,
				upstream: result.upstream,
				records: result.records,
				recorded_at: new Date().toISOString(),
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	return id;
}

function responseHeaders(headers: Headers): Record<string, string> {
	const allowed = new Set(["content-type", "content-encoding", "transfer-encoding"]);
	const result: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		if (allowed.has(key.toLowerCase())) result[key] = value;
	}
	return result;
}

function pipeReadableToResponse(readable: Readable, response: ServerResponse): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const settle = (error?: Error): void => {
			if (settled) return;
			settled = true;
			readable.off("error", fail);
			response.off("error", fail);
			response.off("finish", succeed);
			response.off("close", close);
			if (error) reject(error);
			else resolve();
		};
		const succeed = (): void => {
			settle();
		};
		const fail = (error: Error): void => {
			settle(error);
		};
		const close = (): void => {
			readable.destroy();
			settle();
		};
		readable.on("error", fail);
		response.on("error", fail);
		response.on("finish", succeed);
		response.on("close", close);
		readable.pipe(response);
	});
}

function proxyHeaders(request: IncomingMessage, apiKey: string): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(request.headers)) {
		if (!value) continue;
		const lower = key.toLowerCase();
		if (lower === "authorization" || lower === "host" || lower === "content-length") continue;
		headers[key] = Array.isArray(value) ? value.join(", ") : value;
	}
	headers.Authorization = `Bearer ${apiKey}`;
	return headers;
}

function proxiedModelFromBody(body: Record<string, unknown>): string {
	return stringField(body, "model");
}

async function handleModelProxy(
	request: IncomingMessage,
	response: ServerResponse,
	state: GatewayState,
	config: IrabGatewayConfig,
	fetchImpl: FetchImpl,
	now: () => number,
): Promise<void> {
	const bodyText = await readRequestText(request);
	const body = parseJsonObject(bodyText);
	const url = new URL(request.url ?? "/v1/chat/completions", "http://irab-gateway.local");
	const isModelList = request.method === "GET" && url.pathname === "/v1/models";
	const model = isModelList ? "__model_list__" : requireConfig(proxiedModelFromBody(body), "model");
	const auth = authenticateEvaluator(state, request, now());
	const release = enterQuota(state, config, auth, "model", model, taskIdFromRequest(request, body), now());
	try {
		const upstreamBaseUrl = openAIBaseUrl(requireConfig(config.source.rabyteBaseUrl, "RABYTE_BASE_URL"));
		const upstreamPath = url.pathname.replace(/^\/v1\/?/u, "");
		const upstreamUrl = joinUrl(upstreamBaseUrl, upstreamPath);
		const upstreamResponse = await fetchImpl(upstreamUrl, {
			method: request.method,
			headers: proxyHeaders(request, requireConfig(config.source.rabyteApiKey, "RABYTE_API_KEY")),
			body: bodyText || undefined,
		});
		appendAudit(config.auditPath, {
			type: "model_proxy",
			token_id: auth.token.id,
			evaluator_id: auth.token.evaluatorId,
			model,
			status: upstreamResponse.status,
		});
		response.writeHead(upstreamResponse.status, responseHeaders(upstreamResponse.headers));
		if (upstreamResponse.body) {
			await pipeReadableToResponse(Readable.fromWeb(upstreamResponse.body), response);
			return;
		}
		response.end(await upstreamResponse.text());
	} finally {
		release();
	}
}

async function handleTokenApplication(
	request: IncomingMessage,
	response: ServerResponse,
	state: GatewayState,
	config: IrabGatewayConfig,
): Promise<void> {
	const body = parseJsonObject(await readRequestText(request));
	const application: TokenApplication = {
		id: `app_${randomUUID()}`,
		status: "pending",
		applicantName: stringField(body, "applicantName"),
		email: stringField(body, "email"),
		organization: stringField(body, "organization"),
		purpose: stringField(body, "purpose"),
		modelScope: stringArrayField(body, "modelScope"),
		toolScope: toolArrayField(body, "toolScope"),
		taskSet: stringField(body, "taskSet"),
		createdAt: new Date().toISOString(),
	};
	state.applications.push(application);
	saveState(config.statePath, state);
	appendAudit(config.auditPath, { type: "token_application_created", application_id: application.id });
	sendJson(response, 201, { application_id: application.id, status: application.status });
}

async function handleApproveApplication(
	request: IncomingMessage,
	response: ServerResponse,
	state: GatewayState,
	config: IrabGatewayConfig,
	applicationId: string,
): Promise<void> {
	requireAdmin(config, request);
	const body = parseJsonObject(await readRequestText(request));
	const application = state.applications.find((entry) => entry.id === applicationId);
	if (!application) throw new GatewayHttpError(404, "Token application not found");
	if (application.status !== "pending") throw new GatewayHttpError(409, "Token application is not pending");
	const plaintextToken = createEvaluatorToken();
	const scopes = scopesFromBody(body, defaultScopes(application));
	const token: GatewayTokenRecord = {
		id: `tok_${randomUUID()}`,
		status: "active",
		tokenHash: sha256(plaintextToken),
		evaluatorId: stringField(body, "evaluatorId") || application.email || application.id,
		organization: stringField(body, "organization") || application.organization,
		applicationId: application.id,
		scopes,
		quota: quotaFromBody(body, config.defaultQuota),
		usage: { totalRequests: 0 },
		createdAt: new Date().toISOString(),
		expiresAt: stringField(body, "expiresAt") || new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
	};
	application.status = "approved";
	application.decidedAt = new Date().toISOString();
	state.tokens.push(token);
	saveState(config.statePath, state);
	appendAudit(config.auditPath, {
		type: "token_application_approved",
		application_id: application.id,
		token_id: token.id,
	});
	sendJson(response, 201, {
		token: plaintextToken,
		token_id: token.id,
		expires_at: token.expiresAt,
		scopes: token.scopes,
		quota: token.quota,
	});
}

async function handleRevokeToken(
	request: IncomingMessage,
	response: ServerResponse,
	state: GatewayState,
	config: IrabGatewayConfig,
	tokenId: string,
): Promise<void> {
	requireAdmin(config, request);
	const token = state.tokens.find((entry) => entry.id === tokenId);
	if (!token) throw new GatewayHttpError(404, "Token not found");
	token.status = "revoked";
	token.revokedAt = new Date().toISOString();
	saveState(config.statePath, state);
	appendAudit(config.auditPath, { type: "token_revoked", token_id: token.id });
	sendJson(response, 200, { token_id: token.id, status: token.status });
}

async function handleTool(
	request: IncomingMessage,
	response: ServerResponse,
	state: GatewayState,
	config: IrabGatewayConfig,
	fetchImpl: FetchImpl,
	now: () => number,
	tool: IrabToolName,
): Promise<void> {
	const body = parseJsonObject(await readRequestText(request));
	const auth = authenticateEvaluator(state, request, now());
	const release = enterQuota(state, config, auth, "tool", tool, taskIdFromRequest(request, body), now());
	try {
		const result = await executeTool(tool, fetchImpl, config, body);
		const recordingId = recordRawToolCall(config, auth.token, tool, body, result);
		const sourceIds = result.records.map((record) => record.source_id);
		appendAudit(config.auditPath, {
			type: "tool_call",
			token_id: auth.token.id,
			evaluator_id: auth.token.evaluatorId,
			tool,
			query: result.query,
			source_ids: sourceIds,
			recording_id: recordingId,
		});
		const payload: GatewayToolResponse = {
			tool,
			query: result.query,
			records: result.records,
			message: result.message,
			recording_id: recordingId,
			source_ids: sourceIds,
		};
		sendJson(response, 200, payload);
	} finally {
		release();
	}
}

function routeMatch(path: string, pattern: RegExp): string | undefined {
	const match = pattern.exec(path);
	return match?.[1];
}

export function createIrabGatewayServer(options: IrabGatewayServerOptions = {}): Server {
	const config = mergeConfig(options.config);
	const fetchImpl = options.fetchImpl ?? fetch;
	const now = options.now ?? Date.now;
	const state = loadState(config.statePath);

	return createServer((request, response) => {
		void (async () => {
			const url = new URL(request.url ?? "/", "http://irab-gateway.local");
			const path = url.pathname;

			if (request.method === "GET" && path === "/healthz") {
				sendJson(response, 200, { ok: true });
				return;
			}
			if (request.method === "POST" && path === "/v1/token-applications") {
				await handleTokenApplication(request, response, state, config);
				return;
			}
			const approvalApplicationId = routeMatch(path, /^\/admin\/token-applications\/([^/]+)\/approve$/u);
			if (request.method === "POST" && approvalApplicationId) {
				await handleApproveApplication(request, response, state, config, approvalApplicationId);
				return;
			}
			const revokeTokenId = routeMatch(path, /^\/admin\/tokens\/([^/]+)\/revoke$/u);
			if (request.method === "POST" && revokeTokenId) {
				await handleRevokeToken(request, response, state, config, revokeTokenId);
				return;
			}
			const toolName = routeMatch(path, /^\/v1\/tools\/([^/]+)$/u);
			if (request.method === "POST" && toolName && isIrabToolName(toolName)) {
				await handleTool(request, response, state, config, fetchImpl, now, toolName);
				return;
			}
			if (path.startsWith("/v1/")) {
				await handleModelProxy(request, response, state, config, fetchImpl, now);
				return;
			}

			sendJson(response, 404, { error: "Not found" });
		})().catch((error: unknown) => {
			const status = error instanceof GatewayHttpError ? error.status : 500;
			const message = error instanceof Error ? error.message : "Unknown gateway error";
			sendJson(response, status, { error: message });
		});
	});
}

export function startIrabGatewayServer(options: IrabGatewayServerOptions = {}): Server {
	const config = mergeConfig(options.config);
	const server = createIrabGatewayServer({ ...options, config });
	server.listen(config.port, () => {
		console.log(`IRAB gateway listening on http://127.0.0.1:${config.port}`);
	});
	return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	startIrabGatewayServer();
}
