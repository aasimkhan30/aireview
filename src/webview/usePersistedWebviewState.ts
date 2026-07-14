import * as React from "react";
import { getVsCodeApi } from "./vscodeApi";

export function usePersistedWebviewState<T>(
	normalize: (value: unknown) => T
): [T, React.Dispatch<React.SetStateAction<T>>] {
	const [state, setState] = React.useState<T>(() => normalize(getVsCodeApi().getState<unknown>()));

	React.useEffect(() => {
		getVsCodeApi().setState(state);
	}, [state]);

	return [state, setState];
}
