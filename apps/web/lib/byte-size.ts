const units = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
const megabyte = 1024 * 1024;

/** Binary units, matching how the drive reports storage. */
function format(bytes: number) {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export const ByteSize = {
  format,
  /** Form fields take megabytes; an empty field means no limit. */
  fromMegabytesInput: (value: string) =>
    value ? Math.round(Number(value) * megabyte) : null,
  toMegabytesInput: (bytes: number | null) =>
    bytes === null ? "" : String(Math.round((bytes / megabyte) * 100) / 100),
} as const;
