import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	cosineSimilarity,
	getEmbeddingConfig,
	getFaultKnowledgeQueryVector,
	getStoredVectorIndex,
	getVectorIndexPath,
	vectorIndexMatches,
} from "./knowledge-vectors.ts";

export interface FaultKnowledgeRecord {
	id: string;
	source_id: string;
	source_file: string;
	locator: string;
	page: number | null;
	title: string;
	kind: string;
	trust: string;
	codes: string[];
	text: string;
	agent_use: string;
}

export interface FaultKnowledgeSource {
	sourceId: string;
	title: string;
	kind: string;
	file: string;
	trust: string;
	records: number;
}

interface SearchOptions {
	q?: string;
	code?: string;
	source?: string;
	kind?: string;
	limit?: number;
}

const knowledgePath = resolve(fileURLToPath(new URL("./knowledge/data/knowledge.jsonl", import.meta.url)));
export const maxLimit = 20;
const minimumSemanticScore = 0.15;
const faultCodeInQuery = /(?:^|[^A-Za-z0-9])([FANW]\d{4,6})(?!\d)/i;
let indexPromise: Promise<FaultKnowledgeRecord[]> | undefined;

function normalize(value: string): string {
	return value.toLocaleLowerCase().replace(/[\u0000-\u001f]/g, " ").trim();
}

function tokens(value: string): string[] {
	return normalize(value).split(/[^\p{L}\p{N}_-]+/u).filter((token) => token.length >= 2);
}

function inferFaultCode(query: string): string {
	return query.match(faultCodeInQuery)?.[1]?.trim() ?? "";
}

function isRecord(value: unknown): value is FaultKnowledgeRecord {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	return (
		typeof item.id === "string" &&
		typeof item.source_id === "string" &&
		typeof item.source_file === "string" &&
		typeof item.locator === "string" &&
		(item.page === null || typeof item.page === "number") &&
		typeof item.title === "string" &&
		typeof item.kind === "string" &&
		typeof item.trust === "string" &&
		Array.isArray(item.codes) &&
		item.codes.every((code) => typeof code === "string") &&
		typeof item.text === "string" &&
		typeof item.agent_use === "string"
	);
}

async function loadIndex(): Promise<FaultKnowledgeRecord[]> {
	const contents = await readFile(knowledgePath, "utf8");
	const records: FaultKnowledgeRecord[] = [];
	for (const [lineNumber, line] of contents.split(/\r?\n/).entries()) {
		if (!line.trim()) continue;
		let value: unknown;
		try {
			value = JSON.parse(line) as unknown;
		} catch {
			throw new Error(`知识库索引第 ${lineNumber + 1} 行不是有效 JSON`);
		}
		if (!isRecord(value)) throw new Error(`知识库索引第 ${lineNumber + 1} 行字段无效`);
		records.push(value);
	}
	if (!records.length) throw new Error("知识库索引为空");
	return records;
}

export async function getFaultKnowledgeIndex(): Promise<FaultKnowledgeRecord[]> {
	indexPromise ??= loadIndex().catch((error: unknown) => {
		indexPromise = undefined;
		throw error;
	});
	return indexPromise;
}

function score(item: FaultKnowledgeRecord, query: string, requestedCode: string): number {
	const queryTokens = tokens(query);
	const haystack = normalize(`${item.title} ${item.text} ${item.codes.join(" ")}`);
	const exactCode = Boolean(requestedCode) && item.codes.some((code) => normalize(code) === normalize(requestedCode));
	const tokenHits = queryTokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
	const titleHits = queryTokens.reduce((sum, token) => sum + (normalize(item.title).includes(token) ? 1 : 0), 0);
	return (exactCode ? 100 : 0) + tokenHits * 4 + titleHits * 3;
}

export async function searchFaultKnowledge(options: SearchOptions = {}) {
	const query = options.q?.trim() ?? "";
	const requestedCode = options.code?.trim() || inferFaultCode(query);
	const source = options.source?.trim() ?? "";
	const kind = options.kind?.trim() ?? "";
	const requestedLimit = options.limit ?? 8;
	const limit = Number.isFinite(requestedLimit) ? Math.min(maxLimit, Math.max(1, Math.floor(requestedLimit))) : 8;
	const queryTokens = tokens(query);
	const records = await getFaultKnowledgeIndex();
	const config = getEmbeddingConfig();
	let vectorIndex = null;
	let retrievalNotice: string | undefined;
	if (config) {
		try {
			vectorIndex = await getStoredVectorIndex();
		} catch (error) {
			retrievalNotice = error instanceof Error ? `向量索引无法读取：${error.message}` : "向量索引无法读取";
		}
	}
	const vectorIndexReady = vectorIndexMatches(vectorIndex, records, config);
	if (!vectorIndexReady) vectorIndex = null;
	let queryVector: number[] | null = null;
	let retrieval: "hybrid" | "keyword" = "keyword";
	if (query && !requestedCode && config && vectorIndex) {
		try {
			queryVector = await getFaultKnowledgeQueryVector(query);
			if (queryVector && vectorIndex && queryVector.length !== vectorIndex.dimensions) {
				queryVector = null;
				retrievalNotice = "查询向量维度与索引不一致；当前使用关键词检索";
			}
			retrieval = queryVector ? "hybrid" : "keyword";
		} catch (error) {
			retrievalNotice = error instanceof Error ? error.message : "云端语义检索暂不可用";
		}
	} else if (query && !requestedCode && config && !vectorIndex && !retrievalNotice) {
		retrievalNotice = "向量索引未构建或与当前知识资料、嵌入服务、模型不匹配；当前使用关键词检索";
	}
	const vectorById = new Map(vectorIndex?.items.map((item) => [item.id, item.vector]) ?? []);
	const ranked = records
		.filter(
			(item) =>
				(!source || item.source_id === source) &&
				(!kind || item.kind === kind) &&
				(!requestedCode || item.codes.some((code) => normalize(code) === normalize(requestedCode))),
		)
		.map((item) => {
			const lexicalScore = score(item, query, requestedCode);
			const vector = queryVector ? vectorById.get(item.id) : undefined;
			const semanticScore = vector && queryVector ? Math.max(0, cosineSimilarity(vector, queryVector)) : 0;
			const acceptedSemanticScore = semanticScore >= minimumSemanticScore ? semanticScore : 0;
			return { item, score: lexicalScore + acceptedSemanticScore * 30, semanticScore: acceptedSemanticScore };
		})
		.filter((row) => !queryTokens.length || row.score > 0)
		.sort((a, b) => b.score - a.score || (a.item.page ?? 0) - (b.item.page ?? 0))
		.slice(0, limit);
	return {
		query,
		code: requestedCode || null,
		source: source || null,
		kind: kind || null,
		retrieval,
		...(retrievalNotice ? { retrieval_notice: retrievalNotice } : {}),
		count: ranked.length,
		results: ranked.map(({ item, score: itemScore, semanticScore }) => ({ ...item, score: itemScore, semantic_score: semanticScore })),
	};
}

export async function listFaultKnowledgeSources(): Promise<{ sources: FaultKnowledgeSource[]; records: number }> {
	const records = await getFaultKnowledgeIndex();
	const sourceMap = new Map<string, FaultKnowledgeSource>();
	for (const item of records) {
		const existing = sourceMap.get(item.source_id);
		if (existing) {
			existing.records++;
			continue;
		}
		sourceMap.set(item.source_id, {
			sourceId: item.source_id,
			title: item.title,
			kind: item.kind,
			file: item.source_file,
			trust: item.trust,
			records: 1,
		});
	}
	return { sources: [...sourceMap.values()], records: records.length };
}

export async function getFaultKnowledgeHealth() {
	try {
		const { records } = await listFaultKnowledgeSources();
		const embedding = getEmbeddingConfig();
		let vectors = null;
		let vectorError: string | undefined;
		try {
			vectors = await getStoredVectorIndex();
		} catch (error) {
			vectorError = error instanceof Error ? error.message : "向量索引无法读取";
		}
		const currentRecords = await getFaultKnowledgeIndex();
		const vectorReady = vectorIndexMatches(vectors, currentRecords, embedding);
		return {
			ok: true,
			records,
			index: knowledgePath,
			retrieval: vectorReady ? "hybrid" : "keyword",
			embedding: { configured: Boolean(embedding), model: embedding?.model ?? null },
			vectors: {
				ready: vectorReady,
				records: vectorReady && vectors ? vectors.items.length : 0,
				index: getVectorIndexPath(),
				...(vectorError ? { error: vectorError } : {}),
			},
		};
	} catch (error) {
		return { ok: false, records: 0, index: knowledgePath, error: error instanceof Error ? error.message : "知识库不可用" };
	}
}


