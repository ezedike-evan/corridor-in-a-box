// An ExternalSigner over a Google Cloud KMS Ed25519 key.
//
// Stellar needs PURE Ed25519 over the 32-byte transaction hash, so the key version's
// algorithm must be EC_SIGN_ED25519 and the hash goes in AsymmetricSign's `data` field
// (not `digest`: a digest would be signed as if it were a pre-hash of something else).
// Provider docs: https://docs.cloud.google.com/kms/docs/algorithms and
// https://docs.cloud.google.com/kms/docs/create-validate-signatures
//
// No cloud SDK is imported. `GcpKmsClientLike` is the slice of
// `KeyManagementServiceClient` from @google-cloud/kms that is used, so the SDK stays the
// caller's (optional) dependency and a real client satisfies it as is:
//
//   const client = new KeyManagementServiceClient();
//   const signer = await GcpKmsSigner.create({
//     client,
//     keyVersionName: "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
//   });
//
// IAM, least privilege: the service account needs only
// `cloudkms.cryptoKeyVersions.viewPublicKey` and `cloudkms.cryptoKeyVersions.useToSign`
// on that one key version (roles/cloudkms.signerVerifier is the closest predefined
// role). It must not be able to create versions, destroy them or change IAM.

import type { ExternalSigner } from "../index";
import { checkedSignature, rawEd25519FromSpki, stellarAddress } from "./ed25519";

export interface GcpKmsClientLike {
  getPublicKey(request: {
    name: string;
  }): Promise<readonly [{ pem?: string | null; algorithm?: unknown }, ...unknown[]]>;
  asymmetricSign(request: {
    name: string;
    data: Uint8Array;
  }): Promise<
    readonly [{ signature?: Uint8Array | string | null; name?: string | null }, ...unknown[]]
  >;
}

export interface GcpKmsSignerOptions {
  client: GcpKmsClientLike;
  /** Full resource name of the CryptoKeyVersion. Pinned: a new version is never used silently. */
  keyVersionName: string;
}

export class GcpKmsSigner implements ExternalSigner {
  private constructor(
    readonly publicKey: string,
    private readonly client: GcpKmsClientLike,
    private readonly keyVersionName: string,
  ) {}

  static async create(options: GcpKmsSignerOptions): Promise<GcpKmsSigner> {
    if (!options.keyVersionName) throw new Error("GCP KMS key version name is required");
    const [response] = await options.client.getPublicKey({ name: options.keyVersionName });
    if (typeof response?.pem !== "string") {
      throw new Error("GCP KMS public key response is missing its PEM");
    }
    const raw = rawEd25519FromSpki(response.pem, "GCP KMS");
    return new GcpKmsSigner(stellarAddress(raw), options.client, options.keyVersionName);
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    if (data.byteLength !== 32) throw new Error("GcpKmsSigner expects a 32-byte Stellar hash");
    const [response] = await this.client.asymmetricSign({
      name: this.keyVersionName,
      data,
    });
    return checkedSignature(this.publicKey, data, response?.signature, "GCP KMS");
  }
}
