import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIrabGatewayServer } from "../../../packages/irab-gateway/src/server.ts";

type HttpJsonResult = {
	status: number;
	payload: unknown;
};

type UpstreamCall = {
	url: string;
	authorization: string;
	body: string;
};

let activeServer: Server | undefined;
let tempDirs: string[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	return typeof value === "string" ? value : "";
}

async function listen(server: Server): Promise<string> {
	server.listen(0);
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	return `http://127.0.0.1:${address.port}`;
}

async function stopServer(server: Server | undefined): Promise<void> {
	if (!server || !server.listening) return;
	server.close();
	await once(server, "close");
}

async function postJson(url: string, body: Record<string, unknown>, token?: string): Promise<HttpJsonResult> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (token) headers.Authorization = `Bearer ${token}`;
	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	return { status: response.status, payload: (await response.json()) as unknown };
}

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "irab-gateway-"));
	tempDirs.push(dir);
	return dir;
}

function gatewayPaths(dir: string): { statePath: string; auditPath: string; recordingDir: string } {
	return {
		statePath: join(dir, "state.json"),
		auditPath: join(dir, "audit.jsonl"),
		recordingDir: join(dir, "recordings"),
	};
}

function createFetchImpl(calls: UpstreamCall[]): typeof fetch {
	return async (input: string | URL | Request, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		const url = String(input);
		const body = String(init?.body ?? "");
		calls.push({
			url,
			authorization: headers.get("authorization") ?? "",
			body,
		});

		if (url === "https://paipai.test/paipai_data") {
			return new Response(
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
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		if (url === "https://rabyte.test/v1/chat/completions") {
			return new Response(JSON.stringify({ id: "chatcmpl_test", choices: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		return new Response(JSON.stringify({ error: `Unexpected upstream URL ${url}` }), { status: 404 });
	};
}

async function applyAndApproveToken(
	baseUrl: string,
	body: Record<string, unknown>,
): Promise<{ token: string; tokenId: string }> {
	const application = await postJson(`${baseUrl}/v1/token-applications`, {
		applicantName: "Evaluator",
		email: "eval@example.com",
		organization: "Example Fund",
		purpose: "IRAB benchmark evaluation",
		modelScope: ["allowed-model"],
		toolScope: ["search_paipai"],
		taskSet: "task-1",
	});
	expect(application.status).toBe(201);
	if (!isRecord(application.payload)) throw new Error("Missing application payload");
	const applicationId = stringField(application.payload, "application_id");
	const approval = await postJson(`${baseUrl}/admin/token-applications/${applicationId}/approve`, body, "admin");
	expect(approval.status).toBe(201);
	if (!isRecord(approval.payload)) throw new Error("Missing approval payload");
	return {
		token: stringField(approval.payload, "token"),
		tokenId: stringField(approval.payload, "token_id"),
	};
}

describe("IRaB gateway", () => {
	afterEach(async () => {
		await stopServer(activeServer);
		activeServer = undefined;
		for (const dir of tempDirs) {
			rmSync(dir, { recursive: true, force: true });
		}
		tempDirs = [];
	});

	it("approves evaluator tokens, routes tools, audits calls, records raw replay data, and proxies models", async () => {
		const dir = createTempDir();
		const paths = gatewayPaths(dir);
		const upstreamCalls: UpstreamCall[] = [];
		activeServer = createIrabGatewayServer({
			config: {
				...paths,
				adminToken: "admin",
				recordRawTools: true,
				source: {
					paipaiBaseUrl: "https://paipai.test",
					rabyteBaseUrl: "https://rabyte.test",
					rabyteApiKey: "rabyte_key",
				},
				defaultQuota: { qps: 10, concurrency: 2, totalRequests: 10 },
			},
			fetchImpl: createFetchImpl(upstreamCalls),
		});
		const baseUrl = await listen(activeServer);
		const { token, tokenId } = await applyAndApproveToken(baseUrl, {
			evaluatorId: "eval-1",
			scopes: {
				tools: ["search_paipai"],
				models: ["allowed-model"],
				taskIds: ["task-1"],
			},
			quota: { qps: 10, concurrency: 2, totalRequests: 10 },
		});

		const toolResponse = await postJson(
			`${baseUrl}/v1/tools/search_paipai`,
			{ query: "BYD battery margin", limit: 1, task_id: "task-1" },
			token,
		);
		expect(toolResponse.status).toBe(200);
		expect(isRecord(toolResponse.payload)).toBe(true);
		if (!isRecord(toolResponse.payload)) throw new Error("Missing tool payload");
		expect(stringField(toolResponse.payload, "recording_id")).toBeTruthy();
		expect(toolResponse.payload).toMatchObject({
			tool: "search_paipai",
			query: "BYD battery margin",
		});
		expect(upstreamCalls[0]).toMatchObject({
			url: "https://paipai.test/paipai_data",
		});

		const chatResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ model: "allowed-model", messages: [] }),
		});
		expect(chatResponse.status).toBe(200);
		expect(upstreamCalls[1]).toMatchObject({
			url: "https://rabyte.test/v1/chat/completions",
			authorization: "Bearer rabyte_key",
		});

		expect(existsSync(paths.statePath)).toBe(true);
		expect(readFileSync(paths.auditPath, "utf8")).toContain(tokenId);
		expect(readdirSync(paths.recordingDir)).toHaveLength(1);
	});

	it("enforces total request quota", async () => {
		const dir = createTempDir();
		const paths = gatewayPaths(dir);
		activeServer = createIrabGatewayServer({
			config: {
				...paths,
				adminToken: "admin",
				recordRawTools: false,
				source: { paipaiBaseUrl: "https://paipai.test" },
				defaultQuota: { qps: 10, concurrency: 2, totalRequests: 1 },
			},
			fetchImpl: createFetchImpl([]),
		});
		const baseUrl = await listen(activeServer);
		const { token } = await applyAndApproveToken(baseUrl, {
			evaluatorId: "eval-quota",
			scopes: { tools: ["search_paipai"], taskIds: ["task-1"] },
			quota: { qps: 10, concurrency: 2, totalRequests: 1 },
		});

		const first = await postJson(`${baseUrl}/v1/tools/search_paipai`, { query: "BYD", task_id: "task-1" }, token);
		const second = await postJson(`${baseUrl}/v1/tools/search_paipai`, { query: "BYD", task_id: "task-1" }, token);

		expect(first.status).toBe(200);
		expect(second.status).toBe(429);
	});
});
