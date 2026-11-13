// Resolves symbolic links in a path that may not exist yet, so a link cannot smuggle a call out of the workspace.

import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * The real location of `absolutePath`: links are resolved in the longest part of the path that
 * exists, and the part that does not exist yet is kept as written.
 */
export function canonicalPath(absolutePath: string): string {
	const missing: string[] = [];
	for (let current = absolutePath; ; current = dirname(current)) {
		try {
			return join(realpathSync(current), ...missing);
		} catch {
			// Not there (or not readable): try the parent. The root always resolves.
			if (dirname(current) === current) return absolutePath;
			missing.unshift(basename(current));
		}
	}
}
