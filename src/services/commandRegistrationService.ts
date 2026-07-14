import * as vscode from "vscode";
import type { CommandArguments, CommandCallback, CommandId, CommandResult } from "../common/commands";
import { IDiagnosticsService } from "../diagnostics/diagnosticsService";
import { createServiceIdentifier } from "../util/di";
import { IExtensionContextService } from "./extensionContextService";

export const ICommandRegistrationService =
	createServiceIdentifier<ICommandRegistrationService>("commandRegistrationService");

export interface ICommandRegistrationService {
	readonly _serviceBrand: undefined;
	registerCommand<TCommand extends CommandId>(
		command: TCommand,
		callback: CommandCallback<TCommand>,
		thisArg?: unknown
	): vscode.Disposable;
	executeCommand<TCommand extends CommandId>(
		command: TCommand,
		...args: CommandArguments<TCommand>
	): Thenable<CommandResult<TCommand> | undefined>;
	getCommands(filterInternal?: boolean): Thenable<string[]>;
}

export class CommandRegistrationService implements ICommandRegistrationService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IExtensionContextService private readonly extensionContextService: IExtensionContextService,
		@IDiagnosticsService private readonly diagnostics: IDiagnosticsService
	) {}

	registerCommand<TCommand extends CommandId>(
		command: TCommand,
		callback: CommandCallback<TCommand>,
		thisArg?: unknown
	): vscode.Disposable {
		const wrappedCallback: CommandCallback<TCommand> = async (...args) => {
			const operation = this.diagnostics.startOperation("commands", "command.invoke", () => ({ command }));
			try {
				const result = await callback.apply(thisArg, args);
				operation.complete(() => ({ command }));
				return result;
			} catch (error) {
				operation.fail(error, () => ({ command }));
				throw error;
			}
		};
		const disposable = vscode.commands.registerCommand(command, wrappedCallback);
		this.extensionContextService.context.subscriptions.push(disposable);
		this.diagnostics.debug("commands", "command.registered", () => ({ command }));
		return disposable;
	}

	executeCommand<TCommand extends CommandId>(
		command: TCommand,
		...args: CommandArguments<TCommand>
	): Thenable<CommandResult<TCommand> | undefined> {
		const operation = this.diagnostics.startOperation("commands", "command.execute", () => ({ command }));
		return vscode.commands.executeCommand<CommandResult<TCommand> | undefined>(command, ...args).then(
			(result) => {
				operation.complete(() => ({ command }));
				return result;
			},
			(error: unknown) => {
				operation.fail(error, () => ({ command }));
				throw error;
			}
		);
	}

	getCommands(filterInternal?: boolean): Thenable<string[]> {
		const operation = this.diagnostics.startOperation("commands", "commands.list", () => ({ filterInternal }));
		return vscode.commands.getCommands(filterInternal).then(
			(commands) => {
				operation.complete(() => ({ commandCount: commands.length, filterInternal }));
				return commands;
			},
			(error: unknown) => {
				operation.fail(error, () => ({ filterInternal }));
				throw error;
			}
		);
	}
}
