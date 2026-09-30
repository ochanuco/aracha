import * as wasm from "../../vendor/cha/cha_wasm.js";
import wasmModule from "../../vendor/cha/cha_wasm_bg.wasm";
import type { ChaPort } from "./port";

let port: ChaPort | undefined;

function call<I, O>(fn: (input: string) => string): (input: I) => O {
  return (input) => JSON.parse(fn(JSON.stringify(input))) as O;
}

export function getCha(): ChaPort {
  if (!port) {
    wasm.initSync({ module: wasmModule });
    port = {
      abiVersion: wasm.abi_version,
      blobId: wasm.blob_id,
      prepareRevision: call(wasm.prepare_revision),
      prepareRestore: call(wasm.prepare_restore),
      prepareConflictResolution: call(wasm.prepare_conflict_resolution),
      semanticDiff: call(wasm.semantic_diff),
      prepareOperation: call(wasm.prepare_operation),
    };
  }
  return port;
}
