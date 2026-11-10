// Regenerates corridors/README.md from the corridor manifests. Run after adding
// or editing a manifest, and commit the result:
//
//   pnpm corridors:catalog
//
// tests/corridors.test.ts fails when the committed file no longer matches.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG_PATH, loadAllCorridors, renderCatalog } from "../scripts/corridor-catalog";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

writeFileSync(join(repoRoot, CATALOG_PATH), renderCatalog(loadAllCorridors(repoRoot)));
console.log(`wrote ${CATALOG_PATH}`);
