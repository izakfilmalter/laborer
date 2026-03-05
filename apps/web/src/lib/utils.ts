import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/**
 * Extract a human-readable error message from an unknown error.
 * Handles Error instances and plain objects with a `message` property.
 */
export function extractErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (
		typeof error === "object" &&
		error !== null &&
		"message" in error &&
		typeof (error as Record<string, unknown>).message === "string"
	) {
		return String((error as Record<string, unknown>).message);
	}
	return "An unexpected error occurred";
}

/**
 * Extract the error code from an RPC error.
 * Returns undefined if the error doesn't have a code property.
 *
 * @see Issue #49: Workspace creation error display
 */
export function extractErrorCode(error: unknown): string | undefined {
	if (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof (error as Record<string, unknown>).code === "string"
	) {
		return String((error as Record<string, unknown>).code);
	}
	return undefined;
}
