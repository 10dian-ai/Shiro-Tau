// A content-addressed store for file snapshots: each distinct content is kept once, named by its SHA-256.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Hex SHA-256 of `data`, the name a blob is stored under. */
export function hashContent(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Blobs under one directory, shared by every session that points at it. */
export class BlobStore {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	/** Store `data` and return its hash. Storing the same content again writes nothing. */
	put(data: Buffer): string {
		const hash = hashContent(data);
		const target = this.pathOf(hash);
		if (existsSync(target)) return hash;
		mkdirSync(dirname(target), { recursive: true });
		// Write under a temporary name first so a crash never leaves a truncated blob under its hash.
		const temporary = `${target}.${process.pid}.tmp`;
		writeFileSync(temporary, data);
		renameSync(temporary, target);
		return hash;
	}

	/** Whether a blob with this hash is stored. */
	has(hash: string): boolean {
		return existsSync(this.pathOf(hash));
	}

	/** The content stored under `hash`. Throws when it is missing. */
	get(hash: string): Buffer {
		return readFileSync(this.pathOf(hash));
	}

	private pathOf(hash: string): string {
		return join(this.dir, hash.slice(0, 2), hash.slice(2));
	}
}
