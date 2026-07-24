/**
 * Strip the stack from an expected-user-mistake diagnostic. The message is
 * the whole story; a framework stack under it buries the fix. (For preview
 * startup errors this also matters mechanically: Vite drops the error
 * message when a preview server fails to start and prints only the stack.)
 */
export function stackless(error: Error): Error {
	error.stack = error.message;
	return error;
}
