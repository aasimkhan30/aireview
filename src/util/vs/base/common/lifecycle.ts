/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IDisposable {
	dispose(): void;
}

export function isDisposable<E>(thing: E): thing is E & IDisposable {
	return typeof thing === "object"
		&& thing !== null
		&& typeof (thing as Partial<IDisposable>).dispose === "function";
}

export function dispose<T extends IDisposable>(disposable: T): T;
export function dispose<T extends IDisposable>(disposable: T | undefined): T | undefined;
export function dispose<T extends IDisposable, A extends Iterable<T> = Iterable<T>>(disposables: A): A;
export function dispose<T extends IDisposable>(arg: T | Iterable<T> | undefined): T | Iterable<T> | undefined {
	if (!arg) {
		return arg;
	}

	if (isDisposable(arg)) {
		arg.dispose();
		return arg;
	}

	const errors: unknown[] = [];
	for (const disposable of arg) {
		try {
			disposable.dispose();
		} catch (error) {
			errors.push(error);
		}
	}

	if (errors.length === 1) {
		throw errors[0];
	}
	if (errors.length > 1) {
		throw new AggregateError(errors, "Encountered errors while disposing of store");
	}

	return arg;
}

class FunctionDisposable implements IDisposable {
	private _isDisposed = false;

	constructor(private readonly fn: () => void) {}

	dispose(): void {
		if (this._isDisposed) {
			return;
		}

		this._isDisposed = true;
		this.fn();
	}
}

export function toDisposable(fn: () => void): IDisposable {
	return new FunctionDisposable(fn);
}

export class DisposableStore implements IDisposable {
	private readonly toDispose = new Set<IDisposable>();
	private disposed = false;

	get isDisposed(): boolean {
		return this.disposed;
	}

	add<T extends IDisposable>(disposable: T): T {
		if (!disposable || disposable === Disposable.None) {
			return disposable;
		}

		if (this.disposed) {
			disposable.dispose();
		} else {
			this.toDispose.add(disposable);
		}

		return disposable;
	}

	delete<T extends IDisposable>(disposable: T): void {
		if (this.toDispose.delete(disposable)) {
			disposable.dispose();
		}
	}

	clear(): void {
		try {
			dispose(this.toDispose);
		} finally {
			this.toDispose.clear();
		}
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}

		this.disposed = true;
		this.clear();
	}
}

export abstract class Disposable implements IDisposable {
	static readonly None = Object.freeze<IDisposable>({ dispose(): void {} });

	private readonly store = new DisposableStore();

	dispose(): void {
		this.store.dispose();
	}

	protected _register<T extends IDisposable>(disposable: T): T {
		return this.store.add(disposable);
	}
}
