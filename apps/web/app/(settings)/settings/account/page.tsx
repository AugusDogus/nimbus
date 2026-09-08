import { PasswordSettings } from "./password-settings";

export default function AccountPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-balance text-2xl font-semibold">Account</h1>
      <PasswordSettings />
    </div>
  );
}
