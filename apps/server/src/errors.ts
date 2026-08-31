export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class WarrantViolationError extends Error {
  constructor(
    public readonly clause: string,
    public readonly reason: string,
    public readonly action: string,
    public readonly subject: string | null = null,
  ) {
    super("Warrant violation (" + clause + "): " + reason);
    this.name = "WarrantViolationError";
  }
}

export class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled");
    this.name = "RunCancelledError";
  }
}
