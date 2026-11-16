import { useSuspenseQuery } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import { SettingsRow, SettingsSection } from "../settings-section";
import { PasskeySettings } from "./passkey-settings";
import { PasswordSettings } from "./password-settings";
import { SessionSettings } from "./session-settings";
import { TwoFactorSettings } from "./two-factor-settings";

export function AccountPage() {
  const { data: account } = useSuspenseQuery(
    trpc.account.overview.queryOptions(),
  );
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
          <p className="break-words text-sm">{account.name}</p>
        </SettingsRow>
        <SettingsRow
          label="Email address"
          description="The address you use to sign in to Nimbus."
        >
          <p className="break-all text-sm">{account.email}</p>
        </SettingsRow>
      </SettingsSection>
      <PasswordSettings />
      <TwoFactorSettings enabled={account.twoFactorEnabled} />
      <PasskeySettings passkeys={account.passkeys} />
      <SessionSettings sessions={account.sessions} />
    </div>
  );
}
