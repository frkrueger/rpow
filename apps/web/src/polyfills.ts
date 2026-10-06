// Browser polyfills. Must be imported before anything that touches Solana.
//
// @solana/spl-token's instruction builders (createTransferCheckedInstruction
// etc.) call the bare Node global `Buffer.alloc`. @solana/web3.js imports
// `Buffer` from the npm `buffer` package as a module but never exposes it on
// globalThis, so in the browser unwrap/deposit failed with
// "Buffer is not defined". Expose the same polyfill globally here.
import { Buffer } from 'buffer';

if (typeof (globalThis as any).Buffer === 'undefined') {
  (globalThis as any).Buffer = Buffer;
}
