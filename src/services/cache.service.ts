/**
 * Cache Service — Redis-backed query result cache.
 *
 * Falls back gracefully to a no-op if Redis is unavailable.
 * The cache is an optimization layer — its absence must never
 * cause incorrect behaviour, only slower responses.
 */

import { createClient, RedisClientType } from "redis";

const TTL_SECONDS = 60;
const NAMESPACE = "profiles:";

let client: RedisClientType | null = null;
let connected = false;

export async function connectCache(): Promise<void> {
	const url = process.env.REDIS_URL;
	if (!url) {
		console.warn("REDIS_URL not set — query cache disabled");
		return;
	}

	try {
		client = createClient({ url }) as RedisClientType;
		client.on("error", (e) => {
			console.error("Redis error:", e.message);
			connected = false;
		});
		client.on("ready", () => { connected = true; });
		await client.connect();
		connected = true;
		console.log("Redis cache connected");
	} catch (e) {
		console.warn("Redis connection failed — running without cache:", e);
		client = null;
		connected = false;
	}
}

export async function getCache(key: string): Promise<string | null> {
	if (!client || !connected) return null;
	try {
		return await client.get(key);
	} catch {
		return null;
	}
}

export async function setCache(key: string, value: string): Promise<void> {
	if (!client || !connected) return;
	try {
		await client.set(key, value, { EX: TTL_SECONDS });
	} catch {
		// fail silently — cache write failure is not fatal
	}
}

export async function invalidateNamespace(): Promise<void> {
	if (!client || !connected) return;
	try {
		let cursor = "0";
		do {
			const result = await client.scan(cursor, {
				MATCH: `${NAMESPACE}*`,
				COUNT: 200,
			});
			cursor = result.cursor;
			if (result.keys.length > 0) {
				await client.del(result.keys);
			}
		} while (cursor !== "0");
	} catch (e) {
		console.warn("Cache invalidation failed:", e);
	}
}

export function isCacheConnected(): boolean {
	return connected;
}