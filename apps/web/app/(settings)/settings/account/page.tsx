import { PasswordSettings } from "./password-settings";
import { redirect } from "next/navigation";
import { getSession } from "@/server/files-data";
import { SettingsRow, SettingsSection } from "../settings-section";

export default async function AccountPage() {
  const session = await getSession();
  if (!session) redirect("/login");
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
    </div>
  );
}
