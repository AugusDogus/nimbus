import { and, desc, eq, gt } from "drizzle-orm";
import { redirect } from "next/navigation";
import { deviceLabel } from "@/lib/device-label";
import { db } from "@/server/db";
import { passkey, session as sessions, user } from "@/server/db/schema";
import { getSession } from "@/server/files-data";
import { SettingsRow, SettingsSection } from "../settings-section";
import { PasskeySettings } from "./passkey-settings";
import { PasswordSettings } from "./password-settings";
import { SessionSettings } from "./session-settings";
import { TwoFactorSettings } from "./two-factor-settings";

export default async function AccountPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const userId = session.user.id;
  const [account, activeSessions, passkeys] = await Promise.all([
    db
      .select({ twoFactorEnabled: user.twoFactorEnabled })
      .from(user)
      .where(eq(user.id, userId)),
    db
      .select({
        id: sessions.id,
        userAgent: sessions.userAgent,
        ipAddress: sessions.ipAddress,
        updatedAt: sessions.updatedAt,
      })
      .from(sessions)
      .where(
        and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())),
      )
      .orderBy(desc(sessions.updatedAt)),
    db
      .select({
        id: passkey.id,
        name: passkey.name,
        createdAt: passkey.createdAt,
        deviceType: passkey.deviceType,
      })
      .from(passkey)
      .where(eq(passkey.userId, userId))
      .orderBy(desc(passkey.createdAt)),
  ]);
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-balance text-2xl font-semibold">Account</h1>
        <p className="text-pretty text-sm text-muted-foreground">
          Your identity and sign-in security.
        </p>
      </div>
      <SettingsSection title="Profile">
        <SettingsRow label="Name">
          <p className="break-words text-sm">{session.user.name}</p>
        </SettingsRow>
        <SettingsRow
          label="Email address"
          description="The address you use to sign in to Nimbus."
        >
          <p className="break-all text-sm">{session.user.email}</p>
        </SettingsRow>
      </SettingsSection>
      <PasswordSettings />
      <TwoFactorSettings enabled={account[0]?.twoFactorEnabled ?? false} />
      <PasskeySettings
        passkeys={passkeys.map((entry) => ({
          id: entry.id,
          name: entry.name?.trim() || "Passkey",
          createdAt: entry.createdAt?.getTime() ?? null,
          synced: entry.deviceType === "multiDevice",
        }))}
      />
      <SessionSettings
        sessions={activeSessions.map((entry) => ({
          id: entry.id,
          device: deviceLabel(entry.userAgent),
          mobile: /Mobile|Android|iPhone|iPad/.test(entry.userAgent ?? ""),
          ip: entry.ipAddress,
          lastActive: entry.updatedAt.getTime(),
          current: entry.id === session.session.id,
        }))}
      />
    </div>
  );
}
