import { describe, expect, it } from "vitest";
import { getCha } from "../../src/cha/impl";
import { isChaError, type ChaPort } from "../../src/cha/port";
import blobId from "../../vendor/cha/vectors/blob_id.json";
import prepareConflictResolution from "../../vendor/cha/vectors/prepare_conflict_resolution.json";
import prepareOperation from "../../vendor/cha/vectors/prepare_operation.json";
import prepareRestore from "../../vendor/cha/vectors/prepare_restore.json";
import prepareRevision from "../../vendor/cha/vectors/prepare_revision.json";
import semanticDiff from "../../vendor/cha/vectors/semantic_diff.json";

type Expect = { ok: unknown } | { error: { code: string; context: unknown } };
type VectorFile = { abi: string; function: string; cases: { name: string; input: unknown; expect: Expect }[] };

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

const invoke: Record<string, (cha: ChaPort, input: never) => unknown> = {
  blob_id: (cha, input: { bytes_hex: string }) => cha.blobId(hexToBytes(input.bytes_hex)),
  prepare_revision: (cha, input) => cha.prepareRevision(input),
  prepare_restore: (cha, input) => cha.prepareRestore(input),
  prepare_conflict_resolution: (cha, input) => cha.prepareConflictResolution(input),
  semantic_diff: (cha, input) => cha.semanticDiff(input),
  prepare_operation: (cha, input) => cha.prepareOperation(input),
};

const files = [
  blobId,
  prepareRevision,
  prepareRestore,
  prepareConflictResolution,
  semanticDiff,
  prepareOperation,
] as unknown as VectorFile[];

describe("cha contract vectors against the vendored WASM", () => {
  it("reports the ABI the vectors were written for", () => {
    expect(getCha().abiVersion()).toBe("cha-abi/1");
    for (const file of files) expect(file.abi).toBe("cha-abi/1");
  });

  for (const file of files) {
    describe(file.function, () => {
      it.each(file.cases)("$name", ({ input, expect: expected }) => {
        const run = () => invoke[file.function]!(getCha(), input as never);
        if ("ok" in expected) {
          expect(run()).toEqual(expected.ok);
          return;
        }
        let thrown: unknown;
        try {
          run();
        } catch (e) {
          thrown = e;
        }
        expect(isChaError(thrown)).toBe(true);
        const error = thrown as { code: string; context: unknown };
        expect(error.code).toBe(expected.error.code);
        expect(error.context).toEqual(expected.error.context);
      });
    });
  }
});
