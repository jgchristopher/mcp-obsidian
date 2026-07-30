export class BackendError extends Error {
    failure;
    constructor(failure, message) {
        super(message);
        this.failure = failure;
        this.name = "BackendError";
    }
}
