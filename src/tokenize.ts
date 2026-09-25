import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

export const TOKENIZER_NAME = "o200k_base";

export const TOKENIZER_NOTE =
	"o200k_base (js-tiktoken) approximates Claude's tokenizer and is not it; every count is an estimate, and recent Claude models tokenize the same text into more tokens";

let encoder: Tiktoken | null = null;

export function countTokens(text: string): number {
	encoder ??= new Tiktoken(o200kBase);
	// Special-token strings inside a file are ordinary text here, never a reason to throw.
	return encoder.encode(text, [], []).length;
}
