"use client";

import {
  KeyRound,
  LogOut,
  MoreHorizontal,
  RotateCcwKey,
  Shield,
  ShieldOff,
  UserRound,
  UserRoundCheck,
  UserRoundX,
} from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { securityClient } from "@/lib/security-client";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AdminConfirmation } from "./admin-confirmation-dialog";

type ManagedUser = {
  id: string;
  name: string;
  email: string;
  role?: string | null;
  banned?: boolean | null;
};

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
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  aria-label={`Actions for ${user.email}`}
                >
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() =>
                    onResetPassword({ id: user.id, email: user.email })
                  }
                >
                  <KeyRound />
                  Reset password
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    onConfirm({
                      title: "Reset sign-in methods?",
                      description: `${user.email} will lose two-factor authentication, recovery codes, passkeys and trusted browsers, and will be signed out everywhere. They can then sign in with their password and set these up again. WebDAV app passwords and files are not affected.`,
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
                >
                  <RotateCcwKey />
                  Reset sign-in methods
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    onConfirm({
                      title: "Sign out everywhere?",
                      description: `Every browser signed in as ${user.email} will need to sign in again. WebDAV app passwords keep working; revoking them requires the account owner or disabling the account.`,
                      action: async () => {
                        const result = await authClient.admin.revokeUserSessions({
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
                >
                  <LogOut />
                  Sign out everywhere
                </DropdownMenuItem>
                <DropdownMenuItem
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
                >
                  {user.role === "admin" ? <ShieldOff /> : <Shield />}
                  {user.role === "admin" ? "Remove admin" : "Make admin"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant={user.banned ? "default" : "destructive"}
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
                >
                  {user.banned ? <UserRoundCheck /> : <UserRoundX />}
                  {user.banned ? "Enable" : "Disable"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <div className="size-9 shrink-0" aria-hidden="true" />
          )}
        </li>
      ))}
    </ul>
  );
}
