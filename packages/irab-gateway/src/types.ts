export type IrabSearchToolName = "search_paipai" | "search_global_data" | "search_cn_marketdata" | "search_web";
export type IrabToolName = IrabSearchToolName | "fetch_web";

export type EvidenceCell = string | number | boolean | null;

export type EvidenceTable = {
	columns: string[];
	rows: Record<string, EvidenceCell>[];
};

export type EvidenceRecord = {
	source_id: string;
	title: string;
	date: string;
	publisher: string;
	url: string;
	content: string;
	table: EvidenceTable | null;
	metadata: Record<string, unknown>;
};

export type GatewayToolResponse = {
	tool: IrabToolName;
	query: string;
	records: EvidenceRecord[];
	message?: string;
	recording_id?: string;
	source_ids: string[];
};

export type TokenQuota = {
	qps: number;
	concurrency: number;
	totalRequests: number;
};

export type TokenScopes = {
	tools: IrabToolName[];
	models: string[];
	taskIds: string[];
};

export type TokenApplicationStatus = "approved" | "pending" | "rejected";
export type GatewayTokenStatus = "active" | "revoked";

export type TokenApplication = {
	id: string;
	status: TokenApplicationStatus;
	applicantName: string;
	email: string;
	organization: string;
	purpose: string;
	modelScope: string[];
	toolScope: IrabToolName[];
	taskSet: string;
	createdAt: string;
	decidedAt?: string;
};

export type GatewayTokenRecord = {
	id: string;
	status: GatewayTokenStatus;
	tokenHash: string;
	evaluatorId: string;
	organization: string;
	applicationId?: string;
	scopes: TokenScopes;
	quota: TokenQuota;
	usage: {
		totalRequests: number;
	};
	createdAt: string;
	expiresAt: string;
	revokedAt?: string;
};

export type GatewayState = {
	applications: TokenApplication[];
	tokens: GatewayTokenRecord[];
};

export type SourceConfig = {
	paipaiBaseUrl: string;
	paipaiApiKey: string;
	paipaiAppAgent: string;
	paipaiSign: string;
	paipaiUserId: string;
	globalDataBaseUrl: string;
	websearchServiceUrl: string;
	xiaosuReaderUrl: string;
	xiaosuReaderOverseasUrl: string;
	xiaosuReaderAccessKey: string;
	rabyteBaseUrl: string;
	rabyteApiKey: string;
};

export type IrabGatewayConfig = {
	port: number;
	adminToken: string;
	statePath: string;
	auditPath: string;
	recordingDir: string;
	recordRawTools: boolean;
	defaultQuota: TokenQuota;
	source: SourceConfig;
	toolTimeoutMs: number;
};
