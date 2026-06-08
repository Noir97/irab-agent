import type { EvidenceCell, EvidenceRecord, EvidenceTable } from "./types.ts";

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

function truncateContent(content: string): string {
	if (content.length <= 12_000) return content;
	return `${content.slice(0, 12_000)}\n\n[truncated]`;
}

function normalizeSourceId(prefix: string, rawId: string, index: number): string {
	const clean = rawId
		.trim()
		.replace(/[^a-zA-Z0-9_.:-]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 120);
	return clean || `${prefix}-${index + 1}`;
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

function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter((item) => item.length > 0);
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
		metadata: isRecord(item) ? item : { value: item },
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

export function normalizePayloadRecords(prefix: string, payload: unknown, limit: number): EvidenceRecord[] {
	const items = extractItems(payload, ["data", "records", "results", "items", "chunks"]);
	const sourceItems = items.length > 0 ? items : isRecord(payload) ? [payload] : [];
	return dedupeSourceIds(sourceItems.map((item, index) => evidenceFromUnknown(prefix, item, index))).slice(0, limit);
}

export function normalizeSimpleDataRecords(payload: unknown, query: string): EvidenceRecord[] {
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

export function normalizeGlobalDataRecords(payload: unknown, query: string): EvidenceRecord[] {
	const alphaSource = ["「Alpha派」全球数据库"];
	const indicatorTables = new Map<string, EvidenceRecord>();
	for (const [index, item] of payloadDataRecords(payload).entries()) {
		const parsedTable = markdownTableFromChunks(item);
		if (!parsedTable) continue;
		const indicatorName = indicTableName(item, indicatorTables.size);
		const sourceId = `gateway-global-data-${index + 1}`;
		const sourceData = {
			article_id: sourceId,
			type: "edb",
			id: sourceId,
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

export function normalizeWebRecords(payload: unknown, limit: number): EvidenceRecord[] {
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

export function evidenceFromFetchedContent(
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
