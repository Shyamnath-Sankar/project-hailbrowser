import type { Rpc, RpcResult } from "../shared/messages";

/** Thin wrapper over chrome.runtime.sendMessage with the worker's RPC shape. */
export async function rpc<T>(msg: Rpc): Promise<T> {
  const res = (await chrome.runtime.sendMessage(msg)) as RpcResult | undefined;
  if (!res) throw new Error("No response from the extension worker.");
  if (!res.ok) throw new Error(res.error);
  return res.data as T;
}
