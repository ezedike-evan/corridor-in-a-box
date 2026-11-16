import { createPublicKey } from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * The raw 32-byte key inside an ed25519 SubjectPublicKeyInfo, given as PEM text or
 * DER bytes. Throws, naming `what`, for anything that is not an ed25519 key: a KMS key
 * of another type must fail at construction, not at the first payment.
 */
export function rawEd25519FromSpki(spki: string | Uint8Array, what: string): Buffer {
  let der: Buffer;
  try {
    const key =
      typeof spki === "string"
        ? createPublicKey(spki)
        : createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" });
    der = key.export({ format: "der", type: "spki" });
  } catch {
    throw new Error(`${what} public key is not a readable SPKI public key`);
  }
  if (
    der.length !== SPKI_PREFIX.length + 32 ||
    !der.subarray(0, SPKI_PREFIX.length).equals(SPKI_PREFIX)
  ) {
    throw new Error(`${what} public key is not a raw ed25519 key`);
  }
  return der.subarray(SPKI_PREFIX.length);
}

export function stellarAddress(raw: Buffer): string {
  return StrKey.encodeEd25519PublicKey(raw);
}

/**
 * Accept a signature from a KMS only when it is 64 bytes AND verifies for `publicKey`
 * over `data`. A wrong-length or wrong-key signature is refused here, before the
 * transaction it would have signed is ever submitted.
 */
export function checkedSignature(
  publicKey: string,
  data: Uint8Array,
  signature: Uint8Array | string | null | undefined,
  what: string,
): Uint8Array {
  if (signature === null || signature === undefined) {
    throw new Error(`${what} returned no signature`);
  }
  const bytes =
    typeof signature === "string" ? Buffer.from(signature, "base64") : Buffer.from(signature);
  if (bytes.length !== 64) {
    throw new Error(`${what} returned ${bytes.length} signature bytes; expected 64 (ed25519)`);
  }
  if (!Keypair.fromPublicKey(publicKey).verify(Buffer.from(data), bytes)) {
    throw new Error(`${what} returned a signature that does not verify for its public key`);
  }
  return bytes;
}
