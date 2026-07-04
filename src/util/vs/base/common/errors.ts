/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export function illegalState(name?: string): Error {
	return new Error(name ? `Illegal state: ${name}` : "Illegal state");
}
