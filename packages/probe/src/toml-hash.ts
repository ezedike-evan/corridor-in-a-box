import { createHash } from "node:crypto";

/** SHA-256 over the exact TOML text, encoded as UTF-8, in lowercase hexadecimal. */
export function tomlHash(toml: string): string {
  return createHash("sha256").update(toml).digest("hex");
}
