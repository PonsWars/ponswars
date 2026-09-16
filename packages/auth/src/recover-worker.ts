import { recoverMessageAddress } from 'viem';
import { parentPort } from 'node:worker_threads';

/**
 * One thread that does nothing but recover signers (§45.2).
 *
 * Started by `workerRecovery`. It holds no state and answers by request id, so
 * a pool can keep several requests in flight per thread without any of them
 * being able to see another's message.
 */

const port = parentPort;
if (port === null) {
  throw new Error('recover-worker must be started as a worker thread');
}

port.on('message', (request: { id: number; message: string; signature: string }) => {
  recoverMessageAddress({
    message: request.message,
    signature: request.signature as `0x${string}`,
  }).then(
    (address) => {
      port.postMessage({ id: request.id, address });
    },
    (error: unknown) => {
      port.postMessage({ id: request.id, error: String(error) });
    },
  );
});
