#!/usr/bin/env node

import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PI_SCRIPT = process.env.IRAB_BATCH_PI_SCRIPT
	? resolve(process.env.IRAB_BATCH_PI_SCRIPT)
	: join(REPO_ROOT, "pi-test.sh");
const PROJECT_APPEND_SYSTEM_PROMPT = join(REPO_ROOT, ".pi", "APPEND_SYSTEM.md");
const PROJECT_EXTENSION_PATHS = [
	join(REPO_ROOT, ".pi", "extensions", "irab-finance-tools", "index.ts"),
	join(REPO_ROOT, ".pi", "extensions", "prompt-url-widget.ts"),
	join(REPO_ROOT, ".pi", "extensions", "redraws.ts"),
	join(REPO_ROOT, ".pi", "extensions", "tps.ts"),
];
const DEFAULT_MODEL = "rabyte/wangsu-claude-opus-4-6";
const DEFAULT_CONCURRENCY = 10;
const DEFAULT_OUT_DIR = join(REPO_ROOT, "tmp", "irab-batch-runs", new Date().toISOString().replace(/[:.]/gu, "-"));
const DEFAULT_PI_SKIP_VERSION_CHECK = "1";
const IRAB_TOOL_NAMES = new Set([
	"search_research_corpus",
	"search_global_market_data",
	"search_china_market_data",
	"search_public_web",
	"read_public_webpage",
]);

function printHelp() {
	console.log(`Usage:
  node scripts/irab-batch-example.mjs --input examples/irab-batch-tasks.jsonl

Options:
  --input <path>        JSONL task file. Each line needs {"id","prompt"}.
  --out <dir>           Output directory. Default: tmp/irab-batch-runs/<timestamp>
  --model <model>       Pi model. Default: ${DEFAULT_MODEL}
  --concurrency <n>     Parallel Pi processes. Default: ${DEFAULT_CONCURRENCY}
  --timeout-ms <n>      Per-task timeout. Default: 0, no timeout
  --dry-run             Validate input and write empty result files without running Pi
  --help                Show this help

Task JSONL fields:
  id                    Stable task id used in result filenames
  prompt                Benchmark prompt
  model                 Optional per-task model override
  name                  Optional Pi session name
  appendSystemPrompt    Optional extra system prompt text

Output layout:
  <out>/run.json
  <out>/tasks/<id>/answer.md
  <out>/tasks/<id>/result.json
  <out>/tasks/<id>/events.jsonl
  <out>/tasks/<id>/sources.json
  <out>/tasks/<id>/workspace/
  <out>/tasks/<id>/generated-files/
  <out>/tasks/<id>/artifacts/
`);
}

function parseArgs(argv) {
	const options = {
		input: "",
		outDir: DEFAULT_OUT_DIR,
		model: DEFAULT_MODEL,
		concurrency: DEFAULT_CONCURRENCY,
		timeoutMs: 0,
		dryRun: false,
		help: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
		} else if (arg === "--dry-run") {
			options.dryRun = true;
		} else if (arg === "--input" && argv[index + 1]) {
			options.input = argv[index + 1];
			index += 1;
		} else if (arg === "--out" && argv[index + 1]) {
			options.outDir = argv[index + 1];
			index += 1;
		} else if (arg === "--model" && argv[index + 1]) {
			options.model = argv[index + 1];
			index += 1;
		} else if (arg === "--concurrency" && argv[index + 1]) {
			options.concurrency = parsePositiveInteger(argv[index + 1], "--concurrency");
			index += 1;
		} else if (arg === "--timeout-ms" && argv[index + 1]) {
			options.timeoutMs = parseNonNegativeInteger(argv[index + 1], "--timeout-ms");
			index += 1;
		} else {
			throw new Error(`Unknown or incomplete argument: ${arg}`);
		}
	}

	if (!options.help && !options.input) {
		throw new Error("--input is required");
	}

	options.input = resolve(REPO_ROOT, options.input);
	options.outDir = resolve(REPO_ROOT, options.outDir);
	return options;
}

function parsePositiveInteger(value, label) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${label} must be a positive integer`);
	}
	return parsed;
}

function parseNonNegativeInteger(value, label) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error(`${label} must be a non-negative integer`);
	}
	return parsed;
}

function parseTask(rawLine, lineNumber) {
	let parsed;
	try {
		parsed = JSON.parse(rawLine);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid JSON on line ${lineNumber}: ${message}`);
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Line ${lineNumber} must be a JSON object`);
	}

	const id = readStringField(parsed, "id", lineNumber);
	const prompt = readStringField(parsed, "prompt", lineNumber);
	const model = readOptionalStringField(parsed, "model", lineNumber);
	const name = readOptionalStringField(parsed, "name", lineNumber);
	const appendSystemPrompt = readOptionalStringField(parsed, "appendSystemPrompt", lineNumber);

	return { id, prompt, model, name, appendSystemPrompt };
}

function readStringField(value, field, lineNumber) {
	const fieldValue = value[field];
	if (typeof fieldValue !== "string" || !fieldValue.trim()) {
		throw new Error(`Line ${lineNumber} needs a non-empty string field: ${field}`);
	}
	return fieldValue.trim();
}

function readOptionalStringField(value, field, lineNumber) {
	const fieldValue = value[field];
	if (fieldValue === undefined) return undefined;
	if (typeof fieldValue !== "string" || !fieldValue.trim()) {
		throw new Error(`Line ${lineNumber} field ${field} must be a non-empty string when provided`);
	}
	return fieldValue.trim();
}

async function readTasks(inputPath) {
	const content = await readFile(inputPath, "utf8");
	return content
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.map((line, index) => ({ line, lineNumber: index + 1 }))
		.filter(({ line }) => line && !line.startsWith("#"))
		.map(({ line, lineNumber }) => parseTask(line, lineNumber));
}

function safeFilePart(value) {
	const cleaned = value
		.replace(/[^a-zA-Z0-9_.-]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 80);
	return cleaned || "task";
}

function taskPaths(outDir, taskId) {
	const fileBase = safeFilePart(taskId);
	const taskDir = join(outDir, "tasks", fileBase);
	return {
		fileBase,
		taskDir,
		workspaceDir: join(taskDir, "workspace"),
		generatedFilesDir: join(taskDir, "generated-files"),
		rawArtifactsDir: join(taskDir, "artifacts", "raw"),
		copiedArtifactsDir: join(taskDir, "artifacts", "files"),
		answerPath: join(taskDir, "answer.md"),
		metaPath: join(taskDir, "result.json"),
		eventsPath: join(taskDir, "events.jsonl"),
		sourcesPath: join(taskDir, "sources.json"),
	};
}

async function prepareTaskDirs(paths) {
	await mkdir(paths.workspaceDir, { recursive: true });
	await mkdir(paths.generatedFilesDir, { recursive: true });
	await mkdir(paths.rawArtifactsDir, { recursive: true });
	await mkdir(paths.copiedArtifactsDir, { recursive: true });
}

function shellQuote(value) {
	if (/^[a-zA-Z0-9_./:=@+-]+$/u.test(value)) return value;
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatCommand(args) {
	return args.map(shellQuote).join(" ");
}

function buildPiArgs(task, options) {
	const args = [
		PI_SCRIPT,
		"--mode",
		"json",
		...PROJECT_EXTENSION_PATHS.flatMap((extensionPath) => ["--extension", extensionPath]),
		"--append-system-prompt",
		PROJECT_APPEND_SYSTEM_PROMPT,
		"--model",
		task.model ?? options.model,
		"--name",
		task.name ?? `irab batch ${task.id}`,
		"--no-session",
	];
	if (task.appendSystemPrompt) {
		args.push("--append-system-prompt", task.appendSystemPrompt);
	}
	args.push(task.prompt);
	return args;
}

function buildPiEnv(paths) {
	return {
		...process.env,
		IRAB_ARTIFACT_DIR: paths.rawArtifactsDir,
		PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK ?? DEFAULT_PI_SKIP_VERSION_CHECK,
	};
}

function runPiTask(task, options, paths) {
	const args = buildPiArgs(task, options);
	const env = buildPiEnv(paths);
	const command = formatCommand(args);
	const commandCwd = paths.workspaceDir;
	if (options.dryRun) {
		return Promise.resolve({
			id: task.id,
			argv: args,
			command,
			commandCwd,
			irabArtifactDir: env.IRAB_ARTIFACT_DIR,
			piSkipVersionCheck: env.PI_SKIP_VERSION_CHECK,
			exitCode: 0,
			durationMs: 0,
			stdout: "",
			stderr: "",
			timedOut: false,
		});
	}

	const startedAt = Date.now();
	return new Promise((resolveTask) => {
		const child = spawn(args[0], args.slice(1), {
			cwd: commandCwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let timeout;

		if (options.timeoutMs > 0) {
			timeout = setTimeout(() => {
				timedOut = true;
				child.kill("SIGTERM");
			}, options.timeoutMs);
		}

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("close", (code, signal) => {
			if (timeout) clearTimeout(timeout);
			resolveTask({
				id: task.id,
				argv: args,
				command,
				commandCwd,
				irabArtifactDir: env.IRAB_ARTIFACT_DIR,
				piSkipVersionCheck: env.PI_SKIP_VERSION_CHECK,
				exitCode: code ?? 1,
				signal,
				durationMs: Date.now() - startedAt,
				stdout,
				stderr,
				timedOut,
			});
		});
		child.on("error", (error) => {
			if (timeout) clearTimeout(timeout);
			resolveTask({
				id: task.id,
				argv: args,
				command,
				commandCwd,
				irabArtifactDir: env.IRAB_ARTIFACT_DIR,
				piSkipVersionCheck: env.PI_SKIP_VERSION_CHECK,
				exitCode: 1,
				durationMs: Date.now() - startedAt,
				stdout,
				stderr: `${stderr}${error.message}\n`,
				timedOut,
			});
		});
	});
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
}

function isIrabToolDetails(details) {
	return isRecord(details) && details.mode === "gateway" && IRAB_TOOL_NAMES.has(details.tool) && Array.isArray(details.artifacts);
}

export function parsePiJsonOutput(stdout) {
	const events = [];
	const parseErrors = [];
	const toolResults = [];
	let finalAnswer = "";
	let finalAssistantStopReason;
	let finalAssistantErrorMessage;

	const lines = stdout.split(/\r?\n/u);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index].trim();
		if (!line) continue;

		let event;
		try {
			event = JSON.parse(line);
		} catch (error) {
			parseErrors.push({
				lineNumber: index + 1,
				message: error instanceof Error ? error.message : String(error),
				line: line.slice(0, 500),
			});
			continue;
		}
		events.push(event);

		if (event.type === "message_end" && isRecord(event.message) && event.message.role === "assistant") {
			finalAnswer = textFromContent(event.message.content);
			finalAssistantStopReason = event.message.stopReason;
			finalAssistantErrorMessage = event.message.errorMessage;
		}

		if (event.type === "tool_execution_end" && isRecord(event.result) && isIrabToolDetails(event.result.details)) {
			toolResults.push({
				eventType: event.type,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				isError: event.isError,
				details: event.result.details,
			});
		}
	}

	return {
		events,
		parseErrors,
		finalAnswer,
		finalAssistantStopReason,
		finalAssistantErrorMessage,
		toolResults,
	};
}

async function pathExists(path) {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return false;
		throw error;
	}
}

async function listFilesRecursive(rootDir) {
	if (!(await pathExists(rootDir))) return [];
	const entries = await readdir(rootDir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const path = join(rootDir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listFilesRecursive(path)));
		} else if (entry.isFile()) {
			files.push(path);
		}
	}
	return files.sort();
}

async function ensureParentDir(filePath) {
	await mkdir(dirname(filePath), { recursive: true });
}

async function copyWorkspaceFiles(paths) {
	const files = await listFilesRecursive(paths.workspaceDir);
	const copied = [];
	for (const filePath of files) {
		const workspaceRelativePath = relative(paths.workspaceDir, filePath);
		const copiedPath = join(paths.generatedFilesDir, workspaceRelativePath);
		await ensureParentDir(copiedPath);
		await copyFile(filePath, copiedPath);
		const fileStat = await stat(filePath);
		copied.push({
			workspaceRelativePath,
			workspacePath: relative(paths.taskDir, filePath),
			copiedPath: relative(paths.taskDir, copiedPath),
			sizeBytes: fileStat.size,
		});
	}
	return copied;
}

function extractMarkdownFileReferences(text) {
	const refs = [];
	const markdownLinkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu;
	for (const match of text.matchAll(markdownLinkPattern)) {
		refs.push(match[1]);
	}

	const barePathPattern = /(?:^|\s)([./~]?[a-zA-Z0-9_.-][a-zA-Z0-9_./-]*\.(?:md|csv|json|txt|html|png|jpe?g|webp|pdf|xlsx?))(?:\s|$)/giu;
	for (const match of text.matchAll(barePathPattern)) {
		refs.push(match[1]);
	}

	return [...new Set(refs.map((ref) => ref.split("#")[0]).filter((ref) => ref && !/^[a-z][a-z0-9+.-]*:/iu.test(ref)))];
}

function matchGeneratedFileReferences(answer, generatedFiles) {
	const refs = extractMarkdownFileReferences(answer);
	if (refs.length === 0 || generatedFiles.length === 0) return [];

	const matches = [];
	for (const ref of refs) {
		const normalized = ref.replace(/^\.\//u, "").replace(/^workspace\//u, "");
		const match = generatedFiles.find(
			(file) => file.workspaceRelativePath === normalized || file.copiedPath === normalized || basename(file.workspaceRelativePath) === normalized,
		);
		if (match) {
			matches.push({ reference: ref, ...match });
		}
	}
	return matches;
}

function firstString(...values) {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}

function recordValue(value, key) {
	return isRecord(value) ? value[key] : undefined;
}

function relativeOrAbsolute(baseDir, path) {
	if (!path) return undefined;
	const resolved = resolve(path);
	const rel = relative(baseDir, resolved);
	if (!rel.startsWith("..") && rel !== "..") return rel || ".";
	return resolved;
}

function recordBySourceId(records) {
	const bySourceId = new Map();
	if (!Array.isArray(records)) return bySourceId;
	for (const record of records) {
		if (isRecord(record) && typeof record.source_id === "string") {
			bySourceId.set(record.source_id, record);
		}
	}
	return bySourceId;
}

async function copyArtifactFile(artifact, paths) {
	const filePath = firstString(artifact.file_path);
	if (!filePath || !(await pathExists(filePath))) return undefined;

	const copiedName = `${safeFilePart(String(artifact.id))}-${basename(filePath)}`;
	const copiedPath = join(paths.copiedArtifactsDir, copiedName);
	await ensureParentDir(copiedPath);
	await copyFile(filePath, copiedPath);
	return relative(paths.taskDir, copiedPath);
}

export async function buildSourceMap(task, parsed, paths) {
	const citations = [];
	const toolCalls = [];

	for (const toolResult of parsed.toolResults) {
		const details = toolResult.details;
		const records = Array.isArray(details.results) ? details.results : [];
		const recordsBySourceId = recordBySourceId(records);
		toolCalls.push({
			toolCallId: toolResult.toolCallId,
			toolName: toolResult.toolName,
			irabTool: details.tool,
			query: details.query,
			endpoint: details.endpoint,
			recordingId: details.recording_id,
			artifactDir: relativeOrAbsolute(paths.taskDir, details.artifact_dir),
			resultCount: records.length,
			artifactCount: details.artifacts.length,
			isError: toolResult.isError,
		});

		for (const artifact of details.artifacts) {
			const metadata = isRecord(artifact.metadata) ? artifact.metadata : {};
			const evidenceSourceId = firstString(recordValue(metadata, "source_id"));
			const record = recordsBySourceId.get(evidenceSourceId);
			const copiedArtifactFile = await copyArtifactFile(artifact, paths);
			citations.push({
				citation: firstString(artifact.label, `[source:${artifact.id}]`),
				sourceNumber: artifact.id,
				evidenceSourceId,
				artifactType: artifact.type,
				tool: details.tool,
				query: details.query,
				title: firstString(artifact.title, recordValue(metadata, "title"), recordValue(record, "title")),
				date: firstString(recordValue(metadata, "publish_date"), recordValue(record, "date")),
				publisher: firstString(recordValue(metadata, "publisher"), recordValue(record, "publisher")),
				url: firstString(recordValue(metadata, "url"), recordValue(record, "url")),
				originalArtifactFile: firstString(artifact.file_path),
				copiedArtifactFile,
				metadata,
				record,
			});
		}
	}

	return {
		taskId: task.id,
		generatedAt: new Date().toISOString(),
		sourceCount: citations.length,
		citations,
		toolCalls,
	};
}

async function writeTaskResult(paths, result, parsed, sourceMap, generatedFiles) {
	const answerText = parsed.finalAnswer || "";
	const referencedGeneratedFiles = matchGeneratedFileReferences(answerText, generatedFiles);

	await writeFile(paths.answerPath, answerText, "utf8");
	await writeFile(paths.eventsPath, result.stdout, "utf8");
	await writeFile(paths.sourcesPath, `${JSON.stringify(sourceMap, null, 2)}\n`, "utf8");
	await writeFile(
		paths.metaPath,
		`${JSON.stringify(
			{
				id: result.id,
				argv: result.argv,
				command: result.command,
				commandCwd: result.commandCwd,
				irabArtifactDir: result.irabArtifactDir,
				piSkipVersionCheck: result.piSkipVersionCheck,
				exitCode: result.exitCode,
				signal: result.signal,
				durationMs: result.durationMs,
				timedOut: result.timedOut,
				answerFile: relative(paths.taskDir, paths.answerPath),
				eventsFile: relative(paths.taskDir, paths.eventsPath),
				sourcesFile: relative(paths.taskDir, paths.sourcesPath),
				workspaceDir: relative(paths.taskDir, paths.workspaceDir),
				generatedFilesDir: relative(paths.taskDir, paths.generatedFilesDir),
				rawArtifactsDir: relative(paths.taskDir, paths.rawArtifactsDir),
				copiedArtifactsDir: relative(paths.taskDir, paths.copiedArtifactsDir),
				generatedFiles,
				referencedGeneratedFiles,
				sourceCount: sourceMap.sourceCount,
				toolCallCount: sourceMap.toolCalls.length,
				jsonParseErrors: parsed.parseErrors,
				finalAssistantStopReason: parsed.finalAssistantStopReason,
				finalAssistantErrorMessage: parsed.finalAssistantErrorMessage,
				stderr: result.stderr,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
}

async function runPool(tasks, options) {
	let nextIndex = 0;
	let failed = 0;

	async function worker() {
		while (nextIndex < tasks.length) {
			const task = tasks[nextIndex];
			nextIndex += 1;
			const paths = taskPaths(options.outDir, task.id);
			await prepareTaskDirs(paths);
			console.error(`[irab-batch] start ${task.id}`);
			const result = await runPiTask(task, options, paths);
			const parsed = parsePiJsonOutput(result.stdout);
			const generatedFiles = await copyWorkspaceFiles(paths);
			const sourceMap = await buildSourceMap(task, parsed, paths);
			await writeTaskResult(paths, result, parsed, sourceMap, generatedFiles);
			if (result.exitCode !== 0) failed += 1;
			console.error(`[irab-batch] end ${task.id} exit=${result.exitCode} durationMs=${result.durationMs}`);
		}
	}

	const workers = Array.from({ length: Math.min(options.concurrency, tasks.length) }, () => worker());
	await Promise.all(workers);
	return failed;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return 0;
	}

	const tasks = await readTasks(options.input);
	if (tasks.length === 0) {
		throw new Error(`No tasks found in ${options.input}`);
	}

	await mkdir(options.outDir, { recursive: true });
	await writeFile(
		join(options.outDir, "run.json"),
		`${JSON.stringify(
			{
				input: options.input,
				outDir: options.outDir,
				model: options.model,
				concurrency: options.concurrency,
				timeoutMs: options.timeoutMs,
				dryRun: options.dryRun,
				piSkipVersionCheck: process.env.PI_SKIP_VERSION_CHECK ?? DEFAULT_PI_SKIP_VERSION_CHECK,
				taskCount: tasks.length,
				outputLayout: "tasks/<id>/{answer.md,result.json,events.jsonl,sources.json,workspace,generated-files,artifacts}",
				startedAt: new Date().toISOString(),
			},
			null,
			2,
		)}\n`,
		"utf8",
	);

	console.error(`[irab-batch] input=${options.input}`);
	console.error(`[irab-batch] out=${options.outDir}`);
	console.error(`[irab-batch] tasks=${tasks.length}`);

	const failed = await runPool(tasks, options);
	console.error(`[irab-batch] done failed=${failed}`);
	return failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main()
		.then((exitCode) => {
			process.exitCode = exitCode;
		})
		.catch((error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		});
}
