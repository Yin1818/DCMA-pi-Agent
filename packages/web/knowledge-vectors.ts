import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FaultKnowledgeRecord } from "./knowledge-index.ts";

interface EmbeddingConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
}

interface StoredVectorIndex {
	version: 1;
	baseUrl: string;
	model: string;
	corpusHash: string;
	dimensions: number;
	items: { id: string; vector: number[] }[];
}

const knowledgeDirectory = dirname(fileURLToPath(new URL("./knowledge/data/knowledge.jsonl", import.meta.url)));
const indexPath = resolve(knowledgeDirectory, "vectors.json");
const batchSize = 32;
const maxAttempts = 3;
let vectorIndexPromise: Promise<StoredVectorIndex | null> | undefined;
const queryCache = new Map<string, number[]>();
const corpusHashCache = new WeakMap<FaultKnowledgeRecord[], string>();

export function getEmbeddingConfig(): EmbeddingConfig | null {
	const baseUrl = process.env.EMBEDDING_BASE_URL?.trim().replace(/\/+$/, "");
	const apiKey = process.env.EMBEDDING_API_KEY?.trim();
	const model = process.env.EMBEDDING_MODEL?.trim();
	return baseUrl && apiKey && model ? { baseUrl, apiKey, model } : null;
}

function corpusHash(records: FaultKnowledgeRecord[]): string {
	const cached = corpusHashCache.get(records);
	if (cached) return cached;
	const digest = createHash("sha256").update(JSON.stringify(records)).digest("hex");
	corpusHashCache.set(records, digest);
	return digest;
}

function embeddingInput(record: FaultKnowledgeRecord): string {
	return `${record.title}\n${record.codes.join(" ")}\n${record.text}`;
}

function isStoredVectorIndex(value: unknown): value is StoredVectorIndex {
	if (!value || typeof value !== "object") return false;
	const index = value as Record<string, unknown>;
	return (
		index.version === 1 &&
		typeof index.baseUrl === "string" &&
		typeof index.model === "string" &&
		typeof index.corpusHash === "string" &&
		typeof index.dimensions === "number" &&
		Number.isInteger(index.dimensions) &&
		index.dimensions > 0 &&
		Array.isArray(index.items) &&
		index.items.every(
			(item: unknown) =>
				item !== null &&
				typeof item === "object" &&
				typeof (item as Record<string, unknown>).id === "string" &&
				Array.isArray((item as Record<string, unknown>).vector) &&
				((item as Record<string, unknown>).vector as unknown[]).length === index.dimensions &&
				((item as Record<string, unknown>).vector as unknown[]).every((part) => typeof part === "number" && Number.isFinite(part)) &&
				((item as Record<string, unknown>).vector as number[]).some((part) => part !== 0),
		)
		&& new Set((index.items as { id: string }[]).map((item) => item.id)).size === index.items.length
	);
}

async function loadStoredIndex(): Promise<StoredVectorIndex | null> {
	try {
		const value: unknown = JSON.parse(await readFile(indexPath, "utf8"));
		return isStoredVectorIndex(value) ? value : null;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

export async function getStoredVectorIndex(): Promise<StoredVectorIndex | null> {
	vectorIndexPromise ??= loadStoredIndex().catch((error: unknown) => {
		vectorIndexPromise = undefined;
		throw error;
	});
	return vectorIndexPromise;
}

export async function embedTexts(texts: string[], config: EmbeddingConfig, signal?: AbortSignal): Promise<number[][]> {
	let response: Response | undefined;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			response = await fetch(`${config.baseUrl}/embeddings`, {
				method: "POST",
				headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
				body: JSON.stringify({ model: config.model, input: texts }),
				signal: signal ?? AbortSignal.timeout(30000),
			});
			if (response.ok || (response.status < 500 && response.status !== 429)) break;
		} catch (error) {
			if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
			if (attempt === maxAttempts - 1) throw new Error("嵌入服务连接失败，已达到重试上限");
		}
		if (attempt < maxAttempts - 1) await new Promise((resolveDelay) => setTimeout(resolveDelay, 250 * 2 ** attempt));
	}
	if (!response?.ok) throw new Error(`嵌入服务请求失败（HTTP ${response?.status ?? "未知"}）`);
	const payload: unknown = await response.json();
	if (!payload || typeof payload !== "object" || !Array.isArray((payload as Record<string, unknown>).data)) {
		throw new Error("嵌入服务返回格式无效");
	}
	const data = (payload as { data: unknown[] }).data;
	const vectors = new Array<number[] | undefined>(texts.length);
	for (const row of data) {
		if (!row || typeof row !== "object") throw new Error("嵌入服务返回格式无效");
		const item = row as Record<string, unknown>;
		if (!Number.isInteger(item.index) || !Array.isArray(item.embedding)) throw new Error("嵌入服务返回格式无效");
		if ((item.index as number) < 0 || (item.index as number) >= texts.length) throw new Error("嵌入服务返回索引越界");
		if (
			!item.embedding.every((part) => typeof part === "number" && Number.isFinite(part)) ||
			!item.embedding.some((part) => part !== 0)
		)
			throw new Error("嵌入向量包含无效数值");
		vectors[item.index as number] = item.embedding as number[];
	}
	if (vectors.some((vector) => !vector?.length)) throw new Error("嵌入服务未返回全部向量");
	const dimensions = vectors[0]?.length;
	if (!dimensions || vectors.some((vector) => vector?.length !== dimensions)) throw new Error("嵌入向量维度不一致");
	return vectors as number[][];
}

export async function buildFaultKnowledgeVectorIndex(records: FaultKnowledgeRecord[]): Promise<{ records: number; model: string; dimensions: number }> {
	const config = getEmbeddingConfig();
	if (!config) throw new Error("请配置 EMBEDDING_BASE_URL、EMBEDDING_API_KEY 和 EMBEDDING_MODEL 后再构建向量索引");
	if (!records.length || new Set(records.map((record) => record.id)).size !== records.length) {
		throw new Error("知识库记录为空或包含重复 ID，拒绝构建向量索引");
	}
	const vectors: { id: string; vector: number[] }[] = [];
	let dimensions = 0;
	for (let offset = 0; offset < records.length; offset += batchSize) {
		const batch = records.slice(offset, offset + batchSize);
		const embedded = await embedTexts(batch.map(embeddingInput), config);
		dimensions ||= embedded[0]?.length ?? 0;
		if (embedded.some((vector) => vector.length !== dimensions)) throw new Error("嵌入服务在不同批次返回了不一致的向量维度");
		vectors.push(...batch.map((record, index) => ({ id: record.id, vector: embedded[index] ?? [] })));
	}
	const index: StoredVectorIndex = {
		version: 1,
		baseUrl: config.baseUrl,
		model: config.model,
		corpusHash: corpusHash(records),
		dimensions,
		items: vectors,
	};
	await mkdir(dirname(indexPath), { recursive: true });
	const temporaryPath = `${indexPath}.${randomUUID()}.tmp`;
	await writeFile(temporaryPath, JSON.stringify(index), "utf8");
	await rename(temporaryPath, indexPath);
	vectorIndexPromise = Promise.resolve(index);
	queryCache.clear();
	return { records: vectors.length, model: config.model, dimensions };
}

export async function getFaultKnowledgeQueryVector(query: string): Promise<number[] | null> {
	const config = getEmbeddingConfig();
	if (!config) return null;
	const cacheKey = `${config.baseUrl}\u0000${config.model}\u0000${query}`;
	if (queryCache.has(cacheKey)) return queryCache.get(cacheKey) ?? null;
	const [vector] = await embedTexts([query], config);
	if (!vector) return null;
	queryCache.set(cacheKey, vector);
	if (queryCache.size > 128) queryCache.delete(queryCache.keys().next().value ?? "");
	return vector;
}

export function cosineSimilarity(left: number[], right: number[]): number {
	if (!left.length || left.length !== right.length) return 0;
	let dot = 0;
	let leftMagnitude = 0;
	let rightMagnitude = 0;
	for (let index = 0; index < left.length; index++) {
		const a = left[index] ?? 0;
		const b = right[index] ?? 0;
		dot += a * b;
		leftMagnitude += a * a;
		rightMagnitude += b * b;
	}
	return leftMagnitude && rightMagnitude ? dot / Math.sqrt(leftMagnitude * rightMagnitude) : 0;
}

export function vectorIndexMatches(
	index: StoredVectorIndex | null,
	records: FaultKnowledgeRecord[],
	config: EmbeddingConfig | null,
): index is StoredVectorIndex {
	const indexedIds = new Set(index?.items.map((item) => item.id) ?? []);
	return Boolean(
		index &&
		config &&
		index.baseUrl === config.baseUrl &&
		index.model === config.model &&
		index.corpusHash === corpusHash(records) &&
		index.items.length === records.length &&
		index.items.every((item) => item.vector.length === index.dimensions) &&
		records.every((record) => indexedIds.has(record.id)),
	);
}

export function getVectorIndexPath(): string {
	return indexPath;
}
