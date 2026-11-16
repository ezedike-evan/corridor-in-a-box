import { generateKeyPairSync, sign as nodeSign, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  assertSignerProducesValidSignatures,
  AwsKmsSigner,
  GcpKmsSigner,
  type AwsKmsClientLike,
  type GcpKmsClientLike,
} from "@corridor/stellar";

/** A real local ed25519 key standing in for the KMS-held one. */
function localKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    pem: publicKey.export({ format: "pem", type: "spki" }) as string,
    der: new Uint8Array(publicKey.export({ format: "der", type: "spki" })),
    sign: (data: Uint8Array) => new Uint8Array(nodeSign(null, Buffer.from(data), privateKey)),
  };
}

type Key = ReturnType<typeof localKey>;

function gcpClient(key: Key, over: Partial<GcpKmsClientLike> = {}) {
  const sent: { name: string; data: Uint8Array; digest?: unknown }[] = [];
  const client: GcpKmsClientLike = {
    getPublicKey: async () => [{ pem: key.pem }],
    asymmetricSign: async (req) => {
      sent.push(req);
      return [{ signature: key.sign(req.data) }];
    },
    ...over,
  };
  return { client, sent };
}

function awsClient(key: Key, over: Partial<AwsKmsClientLike> = {}) {
  const sent: Parameters<AwsKmsClientLike["sign"]>[0][] = [];
  const client: AwsKmsClientLike = {
    getPublicKey: async () => ({
      PublicKey: key.der,
      KeySpec: "ECC_NIST_EDWARDS25519",
      KeyUsage: "SIGN_VERIFY",
    }),
    sign: async (input) => {
      sent.push(input);
      return { Signature: key.sign(input.Message) };
    },
    ...over,
  };
  return { client, sent };
}

const KEY_VERSION = "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1";
const hash = () => randomBytes(32);

describe("GcpKmsSigner", () => {
  it("derives the G address from the KMS public key and passes the signer conformance helper", async () => {
    const key = localKey();
    const signer = await GcpKmsSigner.create({
      client: gcpClient(key).client,
      keyVersionName: KEY_VERSION,
    });
    expect(signer.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
    await assertSignerProducesValidSignatures(signer);
  });

  it("signs the raw hash in `data` for the pinned key version, never as a digest", async () => {
    const key = localKey();
    const { client, sent } = gcpClient(key);
    const signer = await GcpKmsSigner.create({ client, keyVersionName: KEY_VERSION });
    const h = hash();
    const sig = await signer.sign(h);
    expect(
      Keypair.fromPublicKey(signer.publicKey).verify(Buffer.from(h), Buffer.from(sig)),
    ).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.name).toBe(KEY_VERSION);
    expect(Buffer.from(sent[0]!.data)).toEqual(h);
    expect(sent[0]).not.toHaveProperty("digest");
  });

  it("refuses a signature of the wrong length before it can be used", async () => {
    const key = localKey();
    const { client } = gcpClient(key, {
      asymmetricSign: async () => [{ signature: new Uint8Array(63) }],
    });
    const signer = await GcpKmsSigner.create({ client, keyVersionName: KEY_VERSION });
    await expect(signer.sign(hash())).rejects.toThrow(/63 signature bytes; expected 64/);
  });

  it("refuses a signature from a different key", async () => {
    const key = localKey();
    const other = localKey();
    const { client } = gcpClient(key, {
      asymmetricSign: async (req) => [{ signature: other.sign(req.data) }],
    });
    const signer = await GcpKmsSigner.create({ client, keyVersionName: KEY_VERSION });
    await expect(signer.sign(hash())).rejects.toThrow(/does not verify for its public key/);
  });

  it("refuses a missing signature, and an input that is not a 32-byte hash", async () => {
    const key = localKey();
    const { client } = gcpClient(key, { asymmetricSign: async () => [{ signature: null }] });
    const signer = await GcpKmsSigner.create({ client, keyVersionName: KEY_VERSION });
    await expect(signer.sign(hash())).rejects.toThrow(/no signature/);
    await expect(signer.sign(new Uint8Array(31))).rejects.toThrow(/32-byte/);
  });

  it("refuses a key that is not ed25519, and a response with no PEM", async () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = ec.publicKey.export({ format: "pem", type: "spki" }) as string;
    const notEd = gcpClient(localKey(), { getPublicKey: async () => [{ pem }] }).client;
    await expect(
      GcpKmsSigner.create({ client: notEd, keyVersionName: KEY_VERSION }),
    ).rejects.toThrow(/not a raw ed25519 key/);
    const noPem = gcpClient(localKey(), { getPublicKey: async () => [{ pem: null }] }).client;
    await expect(
      GcpKmsSigner.create({ client: noPem, keyVersionName: KEY_VERSION }),
    ).rejects.toThrow(/missing its PEM/);
    await expect(
      GcpKmsSigner.create({ client: gcpClient(localKey()).client, keyVersionName: "" }),
    ).rejects.toThrow(/required/);
  });
});

describe("AwsKmsSigner", () => {
  it("derives the G address from the KMS public key and passes the signer conformance helper", async () => {
    const key = localKey();
    const signer = await AwsKmsSigner.create({
      client: awsClient(key).client,
      keyId: "alias/corridor",
    });
    expect(signer.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
    await assertSignerProducesValidSignatures(signer);
  });

  it("asks for pure Ed25519 over the RAW hash: ED25519_SHA_512, not the pre-hash variant", async () => {
    const key = localKey();
    const { client, sent } = awsClient(key);
    const signer = await AwsKmsSigner.create({ client, keyId: "alias/corridor" });
    const h = hash();
    await signer.sign(h);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      KeyId: "alias/corridor",
      MessageType: "RAW",
      SigningAlgorithm: "ED25519_SHA_512",
    });
    expect(Buffer.from(sent[0]!.Message)).toEqual(h);
  });

  it("refuses a signature of the wrong length or from a different key", async () => {
    const key = localKey();
    const other = localKey();
    const short = await AwsKmsSigner.create({
      client: awsClient(key, { sign: async () => ({ Signature: new Uint8Array(65) }) }).client,
      keyId: "k",
    });
    await expect(short.sign(hash())).rejects.toThrow(/65 signature bytes; expected 64/);
    const wrong = await AwsKmsSigner.create({
      client: awsClient(key, { sign: async (i) => ({ Signature: other.sign(i.Message) }) })
        .client,
      keyId: "k",
    });
    await expect(wrong.sign(hash())).rejects.toThrow(/does not verify for its public key/);
    const none = await AwsKmsSigner.create({
      client: awsClient(key, { sign: async () => ({}) }).client,
      keyId: "k",
    });
    await expect(none.sign(hash())).rejects.toThrow(/no signature/);
  });

  it("refuses a key of another spec or usage, and a response with no key", async () => {
    const key = localKey();
    const spec = (KeySpec: string, KeyUsage = "SIGN_VERIFY") =>
      awsClient(key, { getPublicKey: async () => ({ PublicKey: key.der, KeySpec, KeyUsage }) })
        .client;
    await expect(
      AwsKmsSigner.create({ client: spec("ECC_NIST_P256"), keyId: "k" }),
    ).rejects.toThrow(/needs ECC_NIST_EDWARDS25519/);
    await expect(
      AwsKmsSigner.create({
        client: spec("ECC_NIST_EDWARDS25519", "KEY_AGREEMENT"),
        keyId: "k",
      }),
    ).rejects.toThrow(/expected SIGN_VERIFY/);
    const empty = awsClient(key, {
      getPublicKey: async () => ({ KeySpec: "ECC_NIST_EDWARDS25519" }),
    }).client;
    await expect(AwsKmsSigner.create({ client: empty, keyId: "k" })).rejects.toThrow(
      /missing its key/,
    );
    await expect(
      AwsKmsSigner.create({ client: awsClient(key).client, keyId: "" }),
    ).rejects.toThrow(/required/);
  });

  it("derives the same Stellar account as the GCP signer for the same key", async () => {
    const key = localKey();
    const a = await AwsKmsSigner.create({ client: awsClient(key).client, keyId: "k" });
    const b = await GcpKmsSigner.create({
      client: gcpClient(key).client,
      keyVersionName: KEY_VERSION,
    });
    expect(a.publicKey).toBe(b.publicKey);
  });
});
