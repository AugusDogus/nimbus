import path from "node:path";

const normalizeWindowsPath = (value: string) => {
  if (process.platform !== "win32") {
    return value;
  }

  const msysMatch = value.match(/^\/([a-zA-Z])\/(.*)$/);
  if (msysMatch) {
    const drive = msysMatch[1].toUpperCase();
    const rest = msysMatch[2].replace(/\//g, "\\");
    return `${drive}:\\${rest}`;
  }

  return value;
};

export const getDataRoot = () => {
  const raw = process.env.NIMBUS_DATA_ROOT ?? "./data";
  const normalized = normalizeWindowsPath(raw);
  return path.resolve(normalized);
};
