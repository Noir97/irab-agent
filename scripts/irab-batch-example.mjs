#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MODEL = "rabyte/wangsu-claude-opus-4-6";
const DEFAULT_OUT_DIR = join(REPO_ROOT, "tmp", "irab-batch-runs", new Date().toISOString().replace(/[:.]/gu, "-"));

function printHelp() {
	console.log(`Usage:
  node scripts/irab-batch-example.mjs --input examples/irab-batch-tasks.jsonl

Options:
  --input <path>        JSONL task file. Each line needs {"id","prompt"}.
  --out <dir>           Output directory. Default: tmp/irab-batch-runs/<timestamp>
  --model <model>       Pi model. Default: ${DEFAULT_MODEL}
  --concurrency <n>     Parallel Pi processes. Default: 1
  --timeout-ms <n>      Per-task timeout. Default: 0, no timeout
  --dry-run             Validate input and print commands without running Pi
  --help                Show this help

Task JSONL fields:
  id                    Stable task id used in result filenames
  prompt                Benchmark prompt
  model                 Optional per-task model override
  name                  Optional Pi session name
  appendSystemPrompt    Optional extra system prompt text
`);
}

function parseArgs(argv) {
	const options = {
		input: "",
		outDir: DEFAULT_OUT_DIR,
		model: DEFAULT_MODEL,
		concurrency: 1,
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
	return value
		.replace(/[^a-zA-Z0-9_.-]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 80);
}

function buildPiArgs(task, options) {
	const args = ["./pi-test.sh", "--model", task.model ?? options.model, "--name", task.name ?? `irab batch ${task.id}`];
	if (task.appendSystemPrompt) {
		args.push("--append-system-prompt", task.appendSystemPrompt);
	}
	args.push("--print", task.prompt);
	return args;
}

function runPiTask(task, options) {
	const args = buildPiArgs(task, options);
	if (options.dryRun) {
		return Promise.resolve({
			id: task.id,
			command: args.join(" "),
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
			cwd: REPO_ROOT,
			env: process.env,
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
				command: args.join(" "),
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
				command: args.join(" "),
				exitCode: 1,
				durationMs: Date.now() - startedAt,
				stdout,
				stderr: `${stderr}${error.message}\n`,
				timedOut,
			});
		});
	});
}

async function writeResult(outDir, result) {
	const fileBase = safeFilePart(result.id);
	const answerPath = join(outDir, `${fileBase}.md`);
	const metaPath = join(outDir, `${fileBase}.json`);

	await writeFile(answerPath, result.stdout, "utf8");
	await writeFile(
		metaPath,
		`${JSON.stringify(
			{
				id: result.id,
				command: result.command,
				exitCode: result.exitCode,
				signal: result.signal,
				durationMs: result.durationMs,
				timedOut: result.timedOut,
				answerFile: basename(answerPath),
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
			console.error(`[irab-batch] start ${task.id}`);
			const result = await runPiTask(task, options);
			await writeResult(options.outDir, result);
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
				taskCount: tasks.length,
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

main()
	.then((exitCode) => {
		process.exitCode = exitCode;
	})
	.catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
