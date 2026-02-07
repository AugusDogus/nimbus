const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const getStringArray = (value: unknown) => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
};

const getString = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : null;

const hashString = (value: string) => {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
};

export const getPermissionsHash = (session: unknown) => {
  if (!isRecord(session)) {
    return "anon";
  }
  const user = isRecord(session.user) ? session.user : null;
  const subjects = new Set<string>();

  const userId = user ? getString(user.id) : null;
  if (userId) {
    subjects.add(`user:${userId}`);
  }

  if (user) {
    const role = getString(user.role);
    if (role) {
      subjects.add(`role:${role}`);
    }
    for (const roleEntry of getStringArray(user.roles)) {
      subjects.add(`role:${roleEntry}`);
    }
    for (const groupEntry of getStringArray(user.groups)) {
      subjects.add(`group:${groupEntry}`);
    }
    for (const permEntry of getStringArray(user.permissions)) {
      subjects.add(`perm:${permEntry}`);
    }
  }

  const sorted = Array.from(subjects).sort();
  if (sorted.length === 0) {
    return "anon";
  }
  return hashString(sorted.join("|"));
};
