/** The bytes a standard base64 string encodes.
 *
 * Terminal bytes reach the page as base64 — the PTY's output from the core,
 * an OSC 52 clipboard write from a program — and both turn back into bytes
 * here. Throws on a string that is not base64 (what `atob` rejects); a caller
 * handling untrusted input catches. */
export function bytesFromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
