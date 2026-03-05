/**
 * Ring Buffer (Circular Buffer) for terminal scrollback.
 *
 * A fixed-capacity byte buffer backed by a `Uint8Array` that wraps around
 * when full. Used by TerminalManager to store the last N bytes of terminal
 * output for scrollback replay on WebSocket reconnection.
 *
 * @see PRD-terminal-perf.md — "Server-Side Ring Buffer for Scrollback"
 * @see Issue #138
 *
 * Design:
 * - Default capacity: 1MB (1_048_576 bytes)
 * - `write(data)` appends UTF-8 bytes, wrapping when capacity is reached
 * - `read()` returns current contents from oldest to newest
 * - `clear()` resets the buffer
 * - `size` returns current byte count (capped at capacity)
 *
 * The ring buffer uses a write cursor and a `wrapped` flag to track state:
 * - When `wrapped` is false, data occupies `buffer[0..cursor]`
 * - When `wrapped` is true, data occupies `buffer[cursor..capacity] + buffer[0..cursor]`
 */

const DEFAULT_CAPACITY = 1_048_576; // 1MB

export class RingBuffer {
	private readonly buffer: Uint8Array;
	private readonly capacity: number;
	private cursor = 0;
	private wrapped = false;

	constructor(capacity: number = DEFAULT_CAPACITY) {
		if (capacity <= 0) {
			throw new Error(`RingBuffer capacity must be positive, got ${capacity}`);
		}
		this.capacity = capacity;
		this.buffer = new Uint8Array(capacity);
	}

	/**
	 * Write data into the ring buffer. If the data exceeds remaining space,
	 * it wraps around, overwriting the oldest bytes.
	 */
	write(data: Uint8Array): void {
		const len = data.length;
		if (len === 0) {
			return;
		}

		if (len >= this.capacity) {
			// Data is larger than or equal to buffer capacity — only keep the last
			// `capacity` bytes. Copy from the end of `data`.
			const offset = len - this.capacity;
			this.buffer.set(data.subarray(offset));
			this.cursor = 0;
			this.wrapped = true;
			return;
		}

		const spaceToEnd = this.capacity - this.cursor;

		if (len <= spaceToEnd) {
			// Fits without wrapping
			this.buffer.set(data, this.cursor);
			this.cursor += len;
			if (this.cursor === this.capacity) {
				this.cursor = 0;
				this.wrapped = true;
			}
		} else {
			// Needs to wrap around
			// First part: fill to end of buffer
			this.buffer.set(data.subarray(0, spaceToEnd), this.cursor);
			// Second part: wrap to beginning
			const remaining = len - spaceToEnd;
			this.buffer.set(data.subarray(spaceToEnd), 0);
			this.cursor = remaining;
			this.wrapped = true;
		}
	}

	/**
	 * Read the current buffer contents from oldest to newest.
	 * Returns a new Uint8Array (safe to hold onto — it's a copy).
	 */
	read(): Uint8Array {
		if (!this.wrapped) {
			// No wrap — data is in buffer[0..cursor]
			return this.buffer.slice(0, this.cursor);
		}

		// Wrapped — oldest data starts at cursor, newest ends at cursor
		// Layout: [cursor..capacity] + [0..cursor]
		const result = new Uint8Array(this.capacity);
		const tailLength = this.capacity - this.cursor;
		result.set(this.buffer.subarray(this.cursor), 0);
		result.set(this.buffer.subarray(0, this.cursor), tailLength);
		return result;
	}

	/**
	 * Read the buffer contents as a UTF-8 string.
	 * Convenience method for terminal output which is UTF-8 text.
	 */
	readString(): string {
		const bytes = this.read();
		return new TextDecoder().decode(bytes);
	}

	/**
	 * Reset the buffer, discarding all data.
	 */
	clear(): void {
		this.cursor = 0;
		this.wrapped = false;
		// No need to zero the backing array — cursor/wrapped state gates reads
	}

	/**
	 * Current number of bytes stored in the buffer (capped at capacity).
	 */
	get size(): number {
		return this.wrapped ? this.capacity : this.cursor;
	}

	/**
	 * The total capacity of the buffer in bytes.
	 */
	get maxCapacity(): number {
		return this.capacity;
	}
}
