/** Next.js route params are encoded; filesystem paths must be decoded once. */
export function decodeFilePathSegments(pathParam: string[] | string | undefined): string[] {
  if (!pathParam) return [];
  const segments = Array.isArray(pathParam) ? pathParam : [pathParam];
  return segments.map((segment) => decodeURIComponent(segment));
}
