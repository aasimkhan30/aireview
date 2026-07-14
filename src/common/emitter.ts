import { Disposable, type IDisposable, toDisposable } from "../util/vs/base/common/lifecycle";

export type Event<T> = (listener: (event: T) => void) => IDisposable;

export class Emitter<T> extends Disposable {
	private readonly listeners = new Set<(event: T) => void>();

	readonly event: Event<T> = (listener) => {
		this.listeners.add(listener);
		return toDisposable(() => this.listeners.delete(listener));
	};

	fire(event: T): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(event);
			} catch (error) {
				console.error("Unhandled event listener error", error);
			}
		}
	}

	override dispose(): void {
		this.listeners.clear();
		super.dispose();
	}
}
