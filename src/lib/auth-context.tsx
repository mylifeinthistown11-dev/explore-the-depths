import { createContext, useContext, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { getCurrentUser, signOut as signOutFn } from "@/lib/app-auth.functions";

export type CurrentUser = {
  userId: string;
  role: "ADMIN" | "STUDENT";
  studentId: string | null;
  fullName: string;
  batchCode: string | null;
  username: string;
};

export type SessionState = {
  user: CurrentUser | null;
  loading: boolean;
  isAdmin: boolean;
};

export const currentUserQuery = {
  queryKey: ["current-user"] as const,
  queryFn: () => getCurrentUser() as Promise<CurrentUser | null>,
  staleTime: 30_000,
};

const AuthContext = createContext<SessionState>({ user: null, loading: true, isAdmin: false });

export function AuthProvider({ children }: { children: ReactNode }) {
  const { data, isLoading } = useQuery(currentUserQuery);
  const user = data ?? null;

  return (
    <AuthContext.Provider
      value={{ user, loading: isLoading, isAdmin: user?.role === "ADMIN" }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

/** Signs out, clears cached data, and returns to the sign-in page. */
export function useSignOut() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    await queryClient.cancelQueries();
    try {
      await signOutFn();
    } catch {
      /* the cookie is cleared regardless */
    }
    queryClient.clear();
    navigate({ to: "/auth", replace: true });
  };
}
