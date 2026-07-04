/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export class GlobalIdleValue<T> {
	private initialized = false;
	private cachedValue?: T;
	private cachedError: unknown;
	private timeout: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly executor: () => T) {
		this.timeout = setTimeout(() => this.run(), 0);
	}

	get isInitialized(): boolean {
		return this.initialized;
	}

	get value(): T {
		if (!this.initialized) {
			this.dispose();
			this.run();
		}

		if (this.cachedError) {
			throw this.cachedError;
		}

		return this.cachedValue as T;
	}

	dispose(): void {
		if (this.timeout !== undefined) {
			clearTimeout(this.timeout);
			this.timeout = undefined;
		}
	}

	private run(): void {
		if (this.initialized) {
			return;
		}

		this.dispose();
		try {
			this.cachedValue = this.executor();
		} catch (error) {
			this.cachedError = error;
		} finally {
			this.initialized = true;
		}
	}
}
