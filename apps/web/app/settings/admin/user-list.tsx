import {
  KeyRound,
  LogOut,
  MoreHorizontal,
  RotateCcwKey,
  Shield,
  ShieldOff,
  UserRound,
  UserRoundCheck,
  UserRoundCog,
  UserRoundX,
} from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { securityClient } from "@/lib/security-client";
import { Button } from "@/components/ui/button";
import {
  DropdownContent,
  DropdownMenu,
  DropdownSeparator,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import { MenuItem } from "@/components/ui/menu-item";
import { Landing } from "@/lib/landing";
import type { AdminConfirmation } from "./admin-confirmation-dialog";

type ManagedUser = {
  id: string;
  name: string;
  email: string;
  role?: string | null;
  banned?: boolean | null;
};

/** Whether an administrator may sign in as `user`, which adds a row to its menu. */
const canSignInAs = (user: ManagedUser) =>
  user.role !== "admin" && !user.banned;

export function UserList({
  users,
  currentUserId,
  onResetPassword,
  onConfirm,
}: {
  users: ManagedUser[];
  currentUserId: string;
  onResetPassword: (user: { id: string; email: string }) => void;
  onConfirm: (confirmation: AdminConfirmation) => void;
}) {
  return (
    <ul aria-label="Users" className="divide-y divide-border/50">
      {users.map((user) => (
        <li key={user.id} className="flex items-center gap-3 px-4 py-4 sm:px-5">
          <div
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium"
            aria-hidden="true"
          >
            {user.name.trim().charAt(0).toUpperCase() || (
              <UserRound className="size-4" />
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <p className="truncate text-sm font-medium">{user.name}</p>
              {user.id === currentUserId && (
                <span className="text-xs text-muted-foreground">You</span>
              )}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {user.email}
            </p>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground sm:hidden">
              <span>{user.role === "admin" ? "Administrator" : "Member"}</span>
              {user.banned && (
                <span className="text-destructive">Disabled</span>
              )}
            </div>
          </div>
          <div className="hidden items-center gap-2 sm:flex">
            {user.banned && (
              <span className="rounded-md border border-destructive/20 px-2 py-1 text-xs text-destructive">
                Disabled
              </span>
            )}
            <span className="rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground">
              {user.role === "admin" ? "Administrator" : "Member"}
            </span>
          </div>
          {user.id !== currentUserId ? (
            <DropdownMenu>
              <DropdownTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    aria-label={`Actions for ${user.email}`}
                  />
                }
              >
                <MoreHorizontal aria-hidden="true" />
              </DropdownTrigger>
              <DropdownContent align="end">
                <MenuItem
                  index={0}
                  icon={KeyRound}
                  label="Reset password"
                  onSelect={() =>
                    onResetPassword({ id: user.id, email: user.email })
                  }
                />
                {canSignInAs(user) && (
                  <MenuItem
                    index={1}
                    icon={UserRoundCog}
                    label="Sign in as user"
                    onSelect={() =>
                      onConfirm({
                        title: `Sign in as ${user.email}?`,
                        description: `You will use Nimbus as ${user.email} for up to one hour, with their files and permissions, to see what they see or fix something for them. The audit log records when you start and stop and marks everything you do with your name. You cannot change their password, email, sign-in methods, sessions, app passwords or AI connections. Use Stop impersonating at the bottom of the page to return to your account.`,
                        confirmLabel: "Sign in as user",
                        action: async () => {
                          const result = await authClient.admin.impersonateUser(
                            { userId: user.id },
                          );
                          if (result.error)
                            throw new Error(
                              result.error.message ??
                                "Nimbus could not sign you in as this person. You are still signed in as yourself.",
                            );
                          // Starts where the person would after signing in.
                          window.location.assign(Landing.PATH);
                        },
                      })
                    }
                  />
                )}
                <MenuItem
                  index={1 + Number(canSignInAs(user))}
                  icon={RotateCcwKey}
                  label="Reset sign-in methods"
                  onSelect={() =>
                    onConfirm({
                      title: "Reset sign-in methods?",
                      description: `${user.email} will lose two-factor authentication, recovery codes, passkeys and trusted browsers, and will be signed out everywhere. Their WebDAV app passwords will be revoked, which disconnects every WebDAV device until they create new passwords. AI clients connected over MCP will be disconnected. They can then sign in with their password and set these up again. Files are not affected.`,
                      action: async () => {
                        const result =
                          await securityClient.nimbus.admin.resetSecondFactors({
                            userId: user.id,
                          });
                        if (result.error)
                          throw new Error(
                            result.error.message ??
                              "Sign-in methods could not be reset. Nothing was changed.",
                          );
                      },
                    })
                  }
                />
                <MenuItem
                  index={2 + Number(canSignInAs(user))}
                  icon={LogOut}
                  label="Sign out everywhere"
                  onSelect={() =>
                    onConfirm({
                      title: "Sign out everywhere?",
                      description: `Every browser signed in as ${user.email} will need to sign in again, and AI clients connected over MCP will be disconnected. WebDAV app passwords keep working; the account owner can revoke them, or you can reset sign-in methods or disable the account.`,
                      action: async () => {
                        const result =
                          await authClient.admin.revokeUserSessions({
                            userId: user.id,
                          });
                        if (result.error)
                          throw new Error(
                            result.error.message ??
                              "The sessions could not be signed out. Try again.",
                          );
                      },
                    })
                  }
                />
                <MenuItem
                  index={3 + Number(canSignInAs(user))}
                  icon={user.role === "admin" ? ShieldOff : Shield}
                  label={user.role === "admin" ? "Remove admin" : "Make admin"}
                  onSelect={() => {
                    onConfirm({
                      title: "Change administrator access?",
                      description:
                        user.role === "admin"
                          ? `${user.email} will become a regular member and lose administrator privileges.`
                          : `${user.email} will be able to manage all users and files on this server.`,
                      action: async () => {
                        const result = await authClient.admin.setRole({
                          userId: user.id,
                          role: user.role === "admin" ? "user" : "admin",
                        });
                        if (result.error)
                          throw new Error(
                            result.error.message ?? "Could not change role.",
                          );
                      },
                    });
                  }}
                />
                <DropdownSeparator />
                <MenuItem
                  index={4 + Number(canSignInAs(user))}
                  icon={user.banned ? UserRoundCheck : UserRoundX}
                  label={user.banned ? "Enable" : "Disable"}
                  destructive={!user.banned}
                  onSelect={() => {
                    onConfirm({
                      title: user.banned
                        ? "Enable account?"
                        : "Disable account?",
                      description: user.banned
                        ? `${user.email} will be able to sign in again with their existing permissions.`
                        : `${user.email} will lose access to Nimbus. Their files will remain intact.`,
                      action: async () => {
                        const result = user.banned
                          ? await authClient.admin.unbanUser({
                              userId: user.id,
                            })
                          : await authClient.admin.banUser({ userId: user.id });
                        if (result.error)
                          throw new Error(
                            result.error.message ?? "Could not update account.",
                          );
                      },
                    });
                  }}
                />
              </DropdownContent>
            </DropdownMenu>
          ) : (
            <div className="size-9 shrink-0" aria-hidden="true" />
          )}
        </li>
      ))}
    </ul>
  );
}
