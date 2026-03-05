/**
 * useDebouncedValue — a hook that debounces a rapidly-changing value.
 *
 * When the input value changes multiple times within the specified delay,
 * only the final value is emitted after the delay elapses. This prevents
 * expensive downstream computations (like diff parsing and rendering) from
 * running on every intermediate value.
 *
 * The hook also provides a `pending` boolean that is true while a debounce
 * timer is active — i.e., when a newer value has arrived but hasn't been
 * emitted yet. This can be used to show a "processing" indicator.
 *
 * @example
 * ```ts
 * const [debouncedContent, isPending] = useDebouncedValue(rawContent, 300)
 * // debouncedContent updates at most once per 300ms
 * // isPending is true while waiting for the debounce to settle
 * ```
 *
 * @see Issue #91: Diff viewer debounce/throttle for rapid changes
 */

import { useEffect, useRef, useState } from "react";

/**
 * Maximum delay (ms) between the first update and when it's emitted.
 * This ensures updates are eventually shown even under sustained rapid
 * changes, rather than being indefinitely postponed.
 */
const MAX_DELAY_MS = 500;

/**
 * Debounces a value, emitting at most once per `delayMs` milliseconds.
 *
 * Uses a trailing-edge debounce with a maximum wait: if updates keep
 * arriving, the debounced value will emit after at most `MAX_DELAY_MS`
 * from the first unemitted change, ensuring the viewer shows recent
 * content within a bounded delay.
 *
 * @param value - The rapidly-changing input value
 * @param delayMs - Debounce delay in milliseconds (default 300)
 * @returns A tuple of [debouncedValue, isPending]
 */
function useDebouncedValue<T>(
	value: T,
	delayMs = 300
): [debouncedValue: T, isPending: boolean] {
	const [debouncedValue, setDebouncedValue] = useState(value);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const latestValueRef = useRef(value);

	// Track whether the debounced value is behind the latest input
	const isPending = value !== debouncedValue;

	useEffect(() => {
		latestValueRef.current = value;

		// Clear any existing debounce timer
		if (timerRef.current) {
			clearTimeout(timerRef.current);
		}

		// Set up a new trailing-edge debounce timer
		timerRef.current = setTimeout(() => {
			setDebouncedValue(latestValueRef.current);
			// Clear max timer since we've emitted
			if (maxTimerRef.current) {
				clearTimeout(maxTimerRef.current);
				maxTimerRef.current = null;
			}
		}, delayMs);

		// Set up a max-wait timer if one isn't already running.
		// This ensures that under sustained rapid updates (value changes
		// every frame), the debounced value still emits within MAX_DELAY_MS.
		if (!maxTimerRef.current) {
			maxTimerRef.current = setTimeout(() => {
				setDebouncedValue(latestValueRef.current);
				maxTimerRef.current = null;
				// Clear the trailing timer since max wait fired first
				if (timerRef.current) {
					clearTimeout(timerRef.current);
					timerRef.current = null;
				}
			}, MAX_DELAY_MS);
		}

		return () => {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
		};
	}, [value, delayMs]);

	// Cleanup both timers on unmount
	useEffect(() => {
		return () => {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
			}
			if (maxTimerRef.current) {
				clearTimeout(maxTimerRef.current);
			}
		};
	}, []);

	return [debouncedValue, isPending];
}

export { useDebouncedValue };
