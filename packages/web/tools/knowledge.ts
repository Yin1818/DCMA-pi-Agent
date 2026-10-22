import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import {
	type DashboardField,
	type DashboardTable,
	dashboardTables,
	fieldLabels,
	type NumericField,
	numericFields,
} from "../../../dashboard/database/dashboard-types.ts";
import { type StateRuleSet, ToolInputError } from "./contracts.ts";

const MAX_BYTES = 1024 * 1024;
const codeKinds = ["fault", "alarm", "status", "control"] as const;
export type KnowledgeCodeKind = (typeof codeKinds)[number];
export interface KnowledgeIdentity {
	manufacturer: string;
	model: string;
	version: string;
}
export interface KnowledgeSource {
	title: string;
	locator: string;
	revision: string;
}
export interface KnowledgeCode {
	kind: KnowledgeCodeKind;
	code: string;
	meaning: string;
	steps: string[];
}
export interface KnowledgeEntry extends KnowledgeIdentity {
	id: string;
	kind: "manual" | "case";
	text: string;
	source: KnowledgeSource;
	codes?: KnowledgeCode[];
}
interface DeviceProfile {
	table: DashboardTable;
	manufacturer: string | null;
	model: string | null;
	version: string | null;
	source: string;
	units: Partial<Record<NumericField, string>>;
	stateRules?: StateRuleSet;
	deviceName?: string;
	location?: string;
	commissionDate?: string;
	ratedValues?: Partial<Record<NumericField, { value: number; unit: string; source: string }>>;
}
export interface FaultCodeInput extends KnowledgeIdentity {
	code: string;
	kind: KnowledgeCodeKind;
}
export interface MaintenanceSearchInput {
	query: string;
	manufacturer?: string;
	model?: string;
	version?: string;
	limit?: number;
}

function invalid(): never {
	throw new ToolInputError("本地知识配置或查询无效；请检查字段、类型、重复项和大小限制。");
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
	const result = value as Record<string, unknown>;
	if (Object.keys(result).some((key) => !keys.includes(key))) return invalid();
	return result;
}
function string(value: unknown, max: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > max) return invalid();
	return value;
}
function list(value: unknown, max: number): unknown[] {
	if (!Array.isArray(value) || value.length > max) return invalid();
	return value;
}
function identity(value: Record<string, unknown>): KnowledgeIdentity {
	return {
		manufacturer: string(value.manufacturer, 160),
		model: string(value.model, 160),
		version: string(value.version, 160),
	};
}
function code(value: unknown): KnowledgeCode {
	const item = object(value, ["kind", "code", "meaning", "steps"]);
	if (!codeKinds.includes(item.kind as KnowledgeCodeKind)) return invalid();
	return {
		kind: item.kind as KnowledgeCodeKind,
		code: string(item.code, 128),
		meaning: string(item.meaning, 2000),
		steps: list(item.steps, 30).map((step) => string(step, 1000)),
	};
}
function stateRules(value: unknown): StateRuleSet {
	const root = object(value, ["source", "version", "rules"]);
	const rules = list(root.rules, 20);
	if (rules.length === 0) return invalid();
	return {
		source: string(root.source, 500),
		version: string(root.version, 160),
		rules: rules.map((value) => {
			const rule = object(value, ["state", "all"]);
			if (rule.state !== "running" && rule.state !== "stopped" && rule.state !== "fault") return invalid();
			const all = list(rule.all, 10);
			if (all.length === 0) return invalid();
			return {
				state: rule.state,
				all: all.map((value) => {
					const condition = object(value, ["field", "operator", "value"]);
					if (typeof condition.field !== "string" || !Object.hasOwn(fieldLabels, condition.field))
						return invalid();
					if (condition.operator !== "eq" && condition.operator !== "gt" && condition.operator !== "lt")
						return invalid();
					const conditionValue = condition.value;
					if (typeof conditionValue === "number") {
						if (!Number.isFinite(conditionValue)) return invalid();
					} else if (
						condition.operator !== "eq" ||
						typeof conditionValue !== "string" ||
						conditionValue.length > 300
					)
						return invalid();
					return {
						field: condition.field as DashboardField,
						operator: condition.operator,
						value: conditionValue as string | number,
					};
				}),
			};
		}),
	};
}
function profiles(value: unknown): DeviceProfile[] {
	const root = object(value, ["profiles"]);
	const seen = new Set<string>();
	return list(root.profiles, dashboardTables.length).map((value) => {
		const item = object(value, [
			"table",
			"manufacturer",
			"model",
			"version",
			"source",
			"units",
			"stateRules",
			"deviceName",
			"location",
			"commissionDate",
			"ratedValues",
		]);
		if (!dashboardTables.includes(item.table as DashboardTable) || seen.has(String(item.table))) return invalid();
		seen.add(String(item.table));
		const unitsObject = object(item.units, numericFields);
		const units: Partial<Record<NumericField, string>> = {};
		const ratedValues: DeviceProfile["ratedValues"] = {};
		if (item.ratedValues !== undefined) {
			const ratings = object(item.ratedValues, numericFields);
			for (const field of numericFields) {
				if (ratings[field] === undefined) continue;
				const rating = object(ratings[field], ["value", "unit", "source"]);
				if (typeof rating.value !== "number" || !Number.isFinite(rating.value)) return invalid();
				ratedValues[field] = {
					value: rating.value,
					unit: string(rating.unit, 32),
					source: string(rating.source, 500),
				};
			}
		}
		if (
			item.commissionDate !== undefined &&
			(typeof item.commissionDate !== "string" ||
				!/^\d{4}-\d{2}-\d{2}$/.test(item.commissionDate) ||
				!Number.isFinite(Date.parse(`${item.commissionDate}T00:00:00.000Z`)) ||
				new Date(`${item.commissionDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== item.commissionDate)
		)
			return invalid();
		for (const field of numericFields)
			if (unitsObject[field] !== undefined) units[field] = string(unitsObject[field], 32);
		return {
			table: item.table as DashboardTable,
			manufacturer: item.manufacturer === null ? null : string(item.manufacturer, 160),
			model: item.model === null ? null : string(item.model, 160),
			version: item.version === null ? null : string(item.version, 160),
			source: string(item.source, 500),
			units,
			...(item.deviceName === undefined ? {} : { deviceName: string(item.deviceName, 160) }),
			...(item.location === undefined ? {} : { location: string(item.location, 300) }),
			...(item.commissionDate === undefined ? {} : { commissionDate: item.commissionDate as string }),
			...(item.ratedValues === undefined ? {} : { ratedValues }),
			...(item.stateRules === undefined ? {} : { stateRules: stateRules(item.stateRules) }),
		};
	});
}
function entries(value: unknown): KnowledgeEntry[] {
	const root = object(value, ["entries"]);
	const seen = new Set<string>();
	let codeCount = 0;
	return list(root.entries, 500).map((value) => {
		const item = object(value, ["id", "manufacturer", "model", "version", "kind", "text", "source", "codes"]);
		const id = string(item.id, 128);
		if (seen.has(id) || (item.kind !== "manual" && item.kind !== "case")) return invalid();
		seen.add(id);
		const source = object(item.source, ["title", "locator", "revision"]);
		const codes = item.codes === undefined ? undefined : list(item.codes, 100).map(code);
		codeCount += codes?.length ?? 0;
		if (codeCount > 5000) return invalid();
		const codeIds = new Set<string>();
		for (const item of codes ?? []) {
			const key = JSON.stringify([item.kind, item.code]);
			if (codeIds.has(key)) return invalid();
			codeIds.add(key);
		}
		return {
			id,
			...identity(item),
			kind: item.kind,
			text: string(item.text, 20000),
			source: {
				title: string(source.title, 300),
				locator: string(source.locator, 1000),
				revision: string(source.revision, 160),
			},
			...(codes === undefined ? {} : { codes }),
		};
	});
}

async function readConfig<T>(directory: string, filename: string, parse: (value: unknown) => T): Promise<T | null> {
	let handle: FileHandle;
	try {
		handle = await open(join(directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
		return invalid();
	}
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > MAX_BYTES) return invalid();
		const buffer = Buffer.alloc(MAX_BYTES + 1);
		let size = 0;
		while (size < buffer.length) {
			const read = await handle.read(buffer, size, buffer.length - size, size);
			if (read.bytesRead === 0) break;
			size += read.bytesRead;
		}
		if (size > MAX_BYTES) return invalid();
		return parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))) as unknown);
	} catch {
		return invalid();
	} finally {
		try {
			await handle.close();
		} catch {
			invalid();
		}
	}
}

/** Reads only profiles.json and knowledge.json in the caller's private runtime directory. */
export function createKnowledgeService(directory: string) {
	return {
		async getDeviceProfile(table: DashboardTable) {
			if (!dashboardTables.includes(table)) return invalid();
			const data = await readConfig(directory, "profiles.json", profiles);
			const profile = data?.find((item) => item.table === table);
			return {
				table,
				configured: profile !== undefined,
				configurationPresent: data !== null,
				manufacturer: profile?.manufacturer ?? null,
				model: profile?.model ?? null,
				version: profile?.version ?? null,
				deviceName: profile?.deviceName ?? null,
				location: profile?.location ?? null,
				commissionDate: profile?.commissionDate ?? null,
				ratedValues: profile?.ratedValues ?? null,
				kind: table === "real_data" ? "acquired" : "simulation",
				source: profile?.source ?? null,
				sourceStatus: profile ? ("user_provided" as const) : ("unknown" as const),
				verified: false as const,
				fieldLabels,
				stateRules: profile?.stateRules ?? null,
				measurements: numericFields.map((field) => ({
					field,
					label: fieldLabels[field],
					unit: profile?.units[field] ?? null,
					unitStatus: profile?.units[field] ? ("user_configured" as const) : ("unknown" as const),
				})),
			};
		},
		async lookupFaultCode(input: FaultCodeInput) {
			const query = object(input, ["manufacturer", "model", "version", "kind", "code"]);
			const device = identity(query);
			const lookupCode = string(query.code, 128);
			if (!codeKinds.includes(query.kind as KnowledgeCodeKind)) return invalid();
			const data = await readConfig(directory, "knowledge.json", entries);
			const found = (data ?? [])
				.filter(
					(item) =>
						item.manufacturer === device.manufacturer &&
						item.model === device.model &&
						item.version === device.version,
				)
				.flatMap((item) =>
					(item.codes ?? [])
						.filter((code) => code.kind === query.kind && code.code === lookupCode)
						.map((code) => ({
							id: item.id,
							...device,
							...code,
							entryKind: item.kind,
							source: item.source,
							sourceStatus: "user_provided" as const,
							verified: false as const,
						})),
				);
			const matches: typeof found = [];
			let resultSize = 0;
			for (const match of found.slice(0, 10)) {
				const size = Buffer.byteLength(JSON.stringify(match));
				if (resultSize + size > 48000) break;
				resultSize += size;
				matches.push(match);
			}
			return {
				configured: data !== null,
				found: found.length > 0,
				total: found.length,
				hasMore: found.length > matches.length,
				matches,
				verified: false as const,
			};
		},
		async searchMaintenanceKnowledge(input: MaintenanceSearchInput) {
			const query = object(input, ["query", "manufacturer", "model", "version", "limit"]);
			const text = string(query.query, 500).toLocaleLowerCase();
			for (const key of ["manufacturer", "model", "version"] as const)
				if (query[key] !== undefined) string(query[key], 160);
			const limit = query.limit === undefined ? 5 : query.limit;
			if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 10) return invalid();
			const tokens = new Set(text.match(/[\p{L}\p{N}]+/gu) ?? []);
			for (const run of text.match(/[\p{Script=Han}]+/gu) ?? [])
				for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2));
			const data = await readConfig(directory, "knowledge.json", entries);
			const ranked = (data ?? [])
				.filter((item) =>
					(["manufacturer", "model", "version"] as const).every(
						(key) => query[key] === undefined || query[key] === item[key],
					),
				)
				.map((item) => {
					const materials = [
						{ location: "text", text: item.text },
						{ location: "source.title", text: item.source.title },
						...(item.codes ?? []).map((code, index) => ({
							location: `codes[${index}] (${code.kind}:${code.code})`,
							text: [code.code, code.meaning, ...code.steps].join("\n"),
						})),
					];
					const haystack = materials
						.map((part) => part.text)
						.join("\n")
						.toLocaleLowerCase();
					const score =
						(haystack.includes(text) ? 10 : 0) + [...tokens].filter((token) => haystack.includes(token)).length;
					const material =
						materials.find((part) => part.text.toLocaleLowerCase().includes(text)) ??
						materials.find((part) =>
							[...tokens].some((token) => part.text.toLocaleLowerCase().includes(token)),
						) ??
						materials[0];
					const lowered = material.text.toLocaleLowerCase();
					const fullIndex = lowered.indexOf(text);
					const position =
						fullIndex >= 0
							? fullIndex
							: Math.min(...[...tokens].map((token) => lowered.indexOf(token)).filter((index) => index >= 0));
					const start = Math.max(0, Number.isFinite(position) ? position - 100 : 0);
					return {
						item,
						score,
						excerpt: material.text.slice(start, start + 600),
						excerptLocation: material.location,
						excerptOffset: start,
					};
				})
				.filter(({ score }) => score > 0)
				.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
			return {
				configured: data !== null,
				total: ranked.length,
				verified: false as const,
				matches: ranked.slice(0, limit).map(({ item, score, excerpt, excerptLocation, excerptOffset }, index) => ({
					rank: index + 1,
					score,
					id: item.id,
					kind: item.kind,
					manufacturer: item.manufacturer,
					model: item.model,
					version: item.version,
					excerpt,
					excerptLocation,
					excerptOffset,
					source: item.source,
					sourceStatus: "user_provided" as const,
					verified: false as const,
				})),
			};
		},
	};
}
