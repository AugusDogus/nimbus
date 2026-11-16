import { db } from "./db";
import { createDriveStore } from "./drive-store";

export const driveStore = createDriveStore(db);
