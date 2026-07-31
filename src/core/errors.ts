export class LiveChatBridgeError extends Error {
  public readonly code: string;
  public readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'LiveChatBridgeError';
    this.code = code;
    this.status = status;
  }
}

export class UnauthorizedError extends LiveChatBridgeError {
  constructor(message = 'Sign in to chat') {
    super('UNAUTHORIZED', message, 401);
    this.name = 'UnauthorizedError';
  }
}

export class NotFoundError extends LiveChatBridgeError {
  constructor(resource = 'Chat') {
    super('NOT_FOUND', `${resource} not found`, 404);
    this.name = 'NotFoundError';
  }
}

export class ChatAlreadyClaimedError extends LiveChatBridgeError {
  constructor() {
    super('ALREADY_CLAIMED', 'Chat is already claimed by another staff member', 409);
    this.name = 'ChatAlreadyClaimedError';
  }
}
