export const terminalStates = new Set(["complete", "rejected", "error"]);

export function transferId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value))
    throw new Error("Invalid transfer ID");
  return value;
}

export function validateMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message))
    throw new Error("Invalid peer message");
  const transfers = [
    "pull-request",
    "offer",
    "accept",
    "chunk",
    "ack",
    "finish",
    "complete",
    "reject",
  ];
  if (transfers.includes(message.kind)) transferId(message.transferId);
  if (["list", "search", "list-result", "search-result"].includes(message.kind))
    transferId(message.requestId);
  for (const key of ["path", "query", "reason", "error"])
    if (
      message[key] !== undefined &&
      (typeof message[key] !== "string" || message[key].length > 4096)
    )
      throw new Error("Peer metadata is too large");
}

export function reserveJob(jobs, peerId) {
  const active = jobs.filter((job) => !terminalStates.has(job.status));
  if (
    active.length >= 64 ||
    active.filter((job) => job.peerId === peerId).length >= 16
  )
    throw new Error(
      "Too many active transfers; finish or decline existing tasks",
    );
  // Preserve active work; bound only terminal history and never remove user files.
  while (jobs.length >= 500) {
    const index = jobs.findLastIndex((job) => terminalStates.has(job.status));
    if (index < 0) throw new Error("Transfer history is full");
    jobs.splice(index, 1);
  }
}

export class BoundedQueue {
  constructor(limit = 64) {
    this.limit = limit;
    this.pending = 0;
    this.tail = Promise.resolve();
  }
  run(action) {
    if (this.pending >= this.limit)
      return Promise.reject(new Error("Peer queue is full"));
    this.pending++;
    const result = this.tail.then(action);
    this.tail = result.catch(() => {});
    return result.finally(() => {
      this.pending--;
    });
  }
}
