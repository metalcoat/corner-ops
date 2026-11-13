// Raw TCP printing (port 9100) shared by receipt, kitchen and label printers.
import { Socket } from "node:net";

/** Printers must be on the store network: private IPv4, localhost, or a .local/.lan/bare hostname. */
export function validPrinterHost(value: string) {
  if (!value || value.length > 253 || !/^[a-z0-9.-]+$/i.test(value) || value.startsWith(".") || value.endsWith(".")) return false;
  const parts = value.split(".").map(Number);
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255))
    return (
      parts[0] === 10 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254) ||
      parts[0] === 127
    );
  return !value.includes(".") || value.toLowerCase().endsWith(".local") || value.toLowerCase().endsWith(".lan");
}

export async function sendRawToPrinter(config: Record<string, unknown>, data: Buffer) {
  const host = String(config.host || "").trim(),
    port = Number(config.port || 9100);
  if (!validPrinterHost(host) || !Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("A valid printer IP/host and port are required.");
  await new Promise<void>((resolve, reject) => {
    const socket = new Socket(),
      fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };
    socket.setTimeout(4000);
    socket.once("timeout", () => fail(new Error(`Print to ${host}:${port} timed out. Is the printer on and connected?`)));
    socket.once("error", fail);
    socket.connect(port, host, () => socket.end(data));
    socket.once("close", (hadError) => {
      if (!hadError) resolve();
    });
  });
}
