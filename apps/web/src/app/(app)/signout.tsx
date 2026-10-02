"use client";
import { authClient } from "@/lib/auth-client";

export function SignOut() {
  return (
    <button
      className="btn btn-ghost btn-sm"
      onClick={async () => {
        await authClient.signOut();
        window.location.href = "/login";
      }}
    >
      Sign out
    </button>
  );
}
