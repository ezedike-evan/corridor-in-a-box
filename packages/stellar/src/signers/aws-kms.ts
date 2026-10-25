// An ExternalSigner over an AWS KMS Ed25519 key.
//
// Stellar needs PURE Ed25519 over the 32-byte transaction hash. In AWS KMS that is key
// spec ECC_NIST_EDWARDS25519 signed with SigningAlgorithm ED25519_SHA_512 and
// MessageType RAW. ED25519_PH_SHA_512 (Ed25519ph, which pre-hashes) is a different
// signature that Stellar will not accept, and RAW is what stops KMS treating the
// hash as a digest.
// Provider docs: https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html
//
// No cloud SDK is imported. `AwsKmsClientLike` is the slice of the aggregated `KMS`
// client from @aws-sdk/client-kms that is used, so the SDK stays the caller's
// (optional) dependency and a real client satisfies it as is:
//
//   const signer = await AwsKmsSigner.create({ client: new KMS({}), keyId: "alias/corridor" });
//
// IAM, least privilege: the role needs only `kms:GetPublicKey` and `kms:Sign` on that one
// key ARN. Not `kms:*`, and no `kms:CreateGrant`, `kms:ScheduleKeyDeletion` or
// `kms:PutKeyPolicy`.

import type { ExternalSigner } from "../index";
import { checkedSignature, rawEd25519FromSpki, stellarAddress } from "./ed25519";

export interface AwsKmsClientLike {
  getPublicKey(input: { KeyId: string }): Promise<{
    PublicKey?: Uint8Array;
    KeySpec?: string;
    KeyUsage?: string;
  }>;
  sign(input: {
    KeyId: string;
    Message: Uint8Array;
    MessageType: "RAW";
    SigningAlgorithm: "ED25519_SHA_512";
  }): Promise<{ Signature?: Uint8Array }>;
}

export interface AwsKmsSignerOptions {
  client: AwsKmsClientLike;
  /** Key id, key ARN or alias. Prefer a full key ARN, which cannot be re-pointed. */
  keyId: string;
}

export class AwsKmsSigner implements ExternalSigner {
  private constructor(
    readonly publicKey: string,
    private readonly client: AwsKmsClientLike,
    private readonly keyId: string,
  ) {}

  static async create(options: AwsKmsSignerOptions): Promise<AwsKmsSigner> {
    if (!options.keyId) throw new Error("AWS KMS key id is required");
    const key = await options.client.getPublicKey({ KeyId: options.keyId });
    if (key.KeySpec !== "ECC_NIST_EDWARDS25519") {
      throw new Error(
        `AWS KMS key spec is ${key.KeySpec ?? "unknown"}; Stellar needs ECC_NIST_EDWARDS25519`,
      );
    }
    if (key.KeyUsage !== undefined && key.KeyUsage !== "SIGN_VERIFY") {
      throw new Error(`AWS KMS key usage is ${key.KeyUsage}; expected SIGN_VERIFY`);
    }
    if (!key.PublicKey) throw new Error("AWS KMS public key response is missing its key");
    const raw = rawEd25519FromSpki(key.PublicKey, "AWS KMS");
    return new AwsKmsSigner(stellarAddress(raw), options.client, options.keyId);
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    if (data.byteLength !== 32) throw new Error("AwsKmsSigner expects a 32-byte Stellar hash");
    const response = await this.client.sign({
      KeyId: this.keyId,
      Message: data,
      MessageType: "RAW",
      SigningAlgorithm: "ED25519_SHA_512",
    });
    return checkedSignature(this.publicKey, data, response.Signature, "AWS KMS");
  }
}
