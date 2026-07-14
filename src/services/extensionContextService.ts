import type * as vscode from "vscode";
import { createServiceIdentifier } from "../util/di";

export const IExtensionContextService = createServiceIdentifier<IExtensionContextService>("extensionContextService");

export interface IExtensionContextService {
	readonly _serviceBrand: undefined;
	readonly context: vscode.ExtensionContext;
}

export class ExtensionContextService implements IExtensionContextService {
	declare readonly _serviceBrand: undefined;

	constructor(readonly context: vscode.ExtensionContext) {}
}
