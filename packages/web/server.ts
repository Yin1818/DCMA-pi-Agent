import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	createExtensionRuntime,
	ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { type DashboardTable, dashboardTables } from "../../dashboard/database/dashboard-types.ts";
import { createDatabaseServer } from "../../dashboard/database/server.ts";
import { closeDatabase } from "./database.ts";
import { chartToolEvent } from "./tools/chart-stream.ts";
import { handleToolHttp } from "./tools/http.ts";
import { createIndustrialServices, createIndustrialTools } from "./tools/index.ts";
import { industrialSystemPrompt } from "./tools/prompt.ts";
import { preparePrivateDirectory } from "./tools/runtime-files.ts";
import { toolTraceEvent } from "./tools/trace.ts";

const root = fileURLToPath(new URL(".", import.meta.url));
try {
	loadEnvFile(resolve(root, ".env"));
} catch (error) {
	if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
const production = process.argv.includes("--production");
const toolDirectory = resolve(root, ".dcma-runtime");
await preparePrivateDirectory(toolDirectory);
const industrial = createIndustrialServices(toolDirectory);
const port = Number(process.env.DCMA_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("DCMA_PORT 必须是有效端口。");
let runtimePromise: Promise<ModelRuntime> | undefined;
const getRuntime = () => {
	runtimePromise ??= ModelRuntime.create({ allowModelNetwork: false, modelsPath: resolve(root, "models.json") }).catch(
		(error: unknown) => {
			runtimePromise = undefined;
			throw error;
		},
	);
	return runtimePromise;
};
const activeSessions = new Set<Awaited<ReturnType<typeof createAgentSession>>["session"]>();
let activeChatRequests = 0;

function json(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	response.end(JSON.stringify(value));
}
async function readBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > 512 * 1024) throw new Error("请求数据过大");
		chunks.push(buffer);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
function validChat(value: unknown): value is {
	model: string;
	text: string;
	context: string;
	database?: boolean;
	table?: DashboardTable;
	history: { role: "user" | "assistant"; content: string }[];
} {
	if (!value || typeof value !== "object") return false;
	const body = value as Record<string, unknown>;
	return (
		typeof body.model === "string" &&
		body.model.length <= 300 &&
		typeof body.text === "string" &&
		!!body.text.trim() &&
		body.text.length <= 8000 &&
		typeof body.context === "string" &&
		body.context.length <= 128000 &&
		(body.database === undefined || typeof body.database === "boolean") &&
		(body.table === undefined || dashboardTables.some((table) => table === body.table)) &&
		Array.isArray(body.history) &&
		body.history.length <= 20 &&
		body.history.every((item: unknown) => {
			if (!item || typeof item !== "object") return false;
			const message = item as Record<string, unknown>;
			return (
				(message.role === "user" || message.role === "assistant") &&
				typeof message.content === "string" &&
				message.content.length <= 8000
			);
		})
	);
}
async function api(request: IncomingMessage, response: ServerResponse, path: URL): Promise<void> {
	if (await handleToolHttp(request, response, path, industrial)) return;
	if (path.pathname === "/api/health" && request.method === "GET") {
		try {
			const runtime = await getRuntime();
			if (path.searchParams.has("refresh")) await runtime.refresh({ allowNetwork: false });
			const models = runtime
				.getAvailableSnapshot()
				.map((model) => ({ id: `${model.provider}/${model.id}`, name: `${model.provider} · ${model.name}` }));
			json(response, 200, {
				connected: true,
				models,
				message: models.length
					? `DCMA Agent 已连接，${models.length} 个模型可选。`
					: "DCMA Agent 已连接，尚无已授权模型；请配置服务器环境变量中的模型授权后使用 Agent 对话。",
			});
		} catch {
			json(response, 200, {
				connected: true,
				models: [],
				message: "本地服务已连接；DCMA 模型初始化失败，请检查模型数据文件与本机模型配置。",
			});
		}
		return;
	}
	if (path.pathname !== "/api/chat") {
		json(response, 404, { error: "接口不存在" });
		return;
	}
	if (request.method !== "POST") {
		json(response, 405, { error: "仅支持 POST" });
		return;
	}
	if (request.headers["x-dcma-client"] !== "web" || !request.headers["content-type"]?.startsWith("application/json")) {
		json(response, 403, { error: "请求来源或内容类型无效" });
		return;
	}
	let body: unknown;
	try {
		body = await readBody(request);
	} catch {
		json(response, 400, { error: "请求必须是有效 JSON，且不得超过 512 KB" });
		return;
	}
	if (!validChat(body)) {
		json(response, 400, { error: "消息、模型或上下文格式无效" });
		return;
	}
	const runtime = await getRuntime();
	const model = runtime.getAvailableSnapshot().find((item) => `${item.provider}/${item.id}` === body.model);
	if (!model) {
		json(response, 503, { error: "所选模型未授权或不可用。请授权后刷新模型列表。" });
		return;
	}
	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () =>
			`${industrialSystemPrompt}\n本轮当前时刻（UTC）：${new Date().toISOString()}；北京时间为UTC+08:00。`,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
	const industrialTools = createIndustrialTools(body.table ?? "real_data_01", industrial);
	const { session } = await createAgentSession({
		cwd: root,
		modelRuntime: runtime,
		model,
		resourceLoader,
		tools: industrialTools.map((tool) => tool.name),
		customTools: industrialTools,
		sessionManager: SessionManager.inMemory(root),
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
	});
	activeSessions.add(session);
	let failure = "";
	let textLength = 0;
	let disconnected = response.destroyed;
	const close = () => {
		disconnected = true;
		void session.abort();
	};
	response.once("close", close);
	const timeout = setTimeout(() => {
		failure = "模型响应超时，请稍后重试。";
		void session.abort();
	}, 120000);
	const emit = (event: unknown) => {
		if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`);
	};
	const unsubscribe = session.subscribe((event) => {
		const chart = chartToolEvent(event);
		if (chart) emit(chart);
		const trace = toolTraceEvent(event);
		if (trace) emit(trace);
		if (event.type === "message_end" && event.message.role === "assistant") {
			const usage = event.message.usage;
			emit({
				type: "usage",
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				totalTokens: usage.totalTokens,
				cost: usage.cost.total,
			});
		}
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			textLength += event.assistantMessageEvent.delta.length;
			emit({ type: "delta", text: event.assistantMessageEvent.delta });
		}
		if (
			event.type === "message_end" &&
			event.message.role === "assistant" &&
			(event.message.stopReason === "error" || event.message.stopReason === "aborted")
		)
			failure ||= "模型请求失败或被中止，请检查授权与模型服务状态。";
	});
	response.writeHead(200, {
		"Content-Type": "application/x-ndjson; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	try {
		if (disconnected) return;
		await session.prompt(
			`数据模式：${body.database ? "优先查询 MySQL；需要实际数据时必须调用工具，失败不能用示例替代。仅澄清需求时无需读取数据。" : "优先分析侧栏示例或导入文件；用户明确询问数据库时仍可调用数据库工具，不能混淆数据来源。"}\n当前背景：\n${body.context}\n\n此前对话（JSON）：\n${JSON.stringify(body.history)}\n\n当前用户问题：\n${body.text}`,
		);
		if (failure) emit({ type: "error", message: failure });
		else if (!textLength) emit({ type: "error", message: "模型未返回文本，请尝试其他已授权模型。" });
		else emit({ type: "done" });
	} catch {
		emit({ type: "error", message: "模型调用失败，请检查授权、网络与上下文长度。" });
	} finally {
		clearTimeout(timeout);
		unsubscribe();
		response.off("close", close);
		session.dispose();
		activeSessions.delete(session);
		response.end();
	}
}

const dashboardRoot = resolve(root, "../../dashboard/frontend");
const databaseServer = createDatabaseServer();
let vite: ViteDevServer | undefined;
let dashboardVite: ViteDevServer | undefined;
const mimeTypes: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".json": "application/json",
};
if (production) {
	await stat(resolve(root, "dist/index.html"));
	await stat(resolve(dashboardRoot, "dist/index.html"));
}
const server = createServer((request, response) => {
	const host = request.headers.host;
	if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
		json(response, 403, { error: "仅允许本地访问" });
		return;
	}
	if (request.headers.origin && request.headers.origin !== `http://${host}`) {
		json(response, 403, { error: "拒绝跨域请求" });
		return;
	}
	const path = new URL(request.url ?? "/", `http://${host}`);
	if (path.pathname.startsWith("/api/database/")) {
		databaseServer.emit("request", request, response);
	} else if (path.pathname.startsWith("/api/")) {
		const chatRequest = path.pathname === "/api/chat" && request.method === "POST";
		if (chatRequest && activeChatRequests >= 4) {
			json(response, 429, { error: "当前请求过多，请稍后重试" });
			return;
		}
		if (chatRequest) activeChatRequests++;
		void api(request, response, path)
			.catch(() => {
				if (!response.headersSent) json(response, 500, { error: "后端处理失败，请检查本机模型配置" });
				else response.end();
			})
			.finally(() => {
				if (chatRequest) activeChatRequests--;
			});
	} else if (path.pathname === "/dashboard") {
		response.writeHead(302, { Location: `/dashboard/${path.search}` });
		response.end();
	} else if (dashboardVite && path.pathname.startsWith("/dashboard/")) dashboardVite.middlewares(request, response);
	else if (vite) vite.middlewares(request, response);
	else {
		void (async () => {
			if (request.method !== "GET" && request.method !== "HEAD") {
				json(response, 405, { error: "仅支持读取静态页面" });
				return;
			}
			const board = path.pathname.startsWith("/dashboard/");
			const directory = resolve(board ? dashboardRoot : root, "dist");
			const pathname = board ? path.pathname.slice("/dashboard".length) : path.pathname;
			const file = resolve(directory, `.${decodeURIComponent(pathname)}`);
			if (!file.startsWith(`${directory}${sep}`) && file !== directory) {
				json(response, 403, { error: "无效路径" });
				return;
			}
			let target = file;
			try {
				if (!(await stat(target)).isFile()) target = resolve(directory, "index.html");
			} catch {
				if (extname(file)) {
					json(response, 404, { error: "文件不存在" });
					return;
				}
				target = resolve(directory, "index.html");
			}
			response.writeHead(200, {
				"Content-Type": mimeTypes[extname(target)] ?? "application/octet-stream",
				"X-Content-Type-Options": "nosniff",
			});
			response.end(request.method === "HEAD" ? undefined : await readFile(target));
		})().catch(() => {
			if (!response.headersSent) json(response, 500, { error: "页面读取失败" });
			else response.end();
		});
	}
});
if (!production) {
	vite = await createViteServer({
		root,
		configFile: resolve(root, "vite.config.ts"),
		server: { middlewareMode: true, host: "127.0.0.1", hmr: { server, path: "/chat-hmr" } },
		appType: "spa",
	});
	dashboardVite = await createViteServer({
		root: dashboardRoot,
		configFile: resolve(dashboardRoot, "vite.config.ts"),
		base: "/dashboard/",
		server: { middlewareMode: true, host: "127.0.0.1", proxy: {}, hmr: { server, path: "/dashboard-hmr" } },
		appType: "spa",
	});
}
server.on("error", (error) => {
	console.error(`DCMA 启动失败：${error.message}`);
	process.exitCode = 1;
	void vite?.close();
	void dashboardVite?.close();
	void industrial.monitoring.stop().finally(closeDatabase);
});
server.listen(port, "127.0.0.1", () => {
	industrial.monitoring.start();
	console.log(`DCMA 前端与 Agent API 已启动：http://127.0.0.1:${port}`);
});
let shuttingDown = false;
const shutdown = () => {
	if (shuttingDown) return;
	shuttingDown = true;
	for (const session of activeSessions) {
		void session.abort();
		session.dispose();
	}
	void vite?.close();
	void dashboardVite?.close();
	void industrial.monitoring.stop().finally(closeDatabase);
	server.close();
	server.closeAllConnections();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
