export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} kB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** A file's bytes, through FileReader (works in every browser and in jsdom). */
export function readFileBytes(file: Blob): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error ?? new Error('The file could not be read.'));
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.readAsArrayBuffer(file);
  });
}
