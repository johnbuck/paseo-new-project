import type { PluginOpenScreenInput } from "@getpaseo/plugin/client";

let opener: ((input: PluginOpenScreenInput) => void) | null = null;

export function setOpenScreenHandler(handler: (input: PluginOpenScreenInput) => void): void {
  opener = handler;
}

export function openScreen(input: PluginOpenScreenInput): void {
  opener?.(input);
}
