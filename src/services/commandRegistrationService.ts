import * as vscode from "vscode";
import type { CommandArguments, CommandCallback, CommandId, CommandResult } from "../common/commands";
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

	constructor(@IExtensionContextService private readonly extensionContextService: IExtensionContextService) {}

	registerCommand<TCommand extends CommandId>(
		command: TCommand,
		callback: CommandCallback<TCommand>,
		thisArg?: unknown
	): vscode.Disposable {
		const disposable = vscode.commands.registerCommand(command, callback, thisArg);
		this.extensionContextService.context.subscriptions.push(disposable);
		return disposable;
	}

	executeCommand<TCommand extends CommandId>(
		command: TCommand,
		...args: CommandArguments<TCommand>
	): Thenable<CommandResult<TCommand> | undefined> {
		return vscode.commands.executeCommand<CommandResult<TCommand> | undefined>(command, ...args);
	}

	getCommands(filterInternal?: boolean): Thenable<string[]> {
		return vscode.commands.getCommands(filterInternal);
	}
}
