import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ADMIN_COOKIE, getAdminSessionToken } from "@/lib/auth";

/**
 * API endpoints the public booking chatbot needs without logging in.
 * Everything else under /api/ (customer data, editing prices, rooms,
 * instructors, reservation management…) requires an admin session.
 */
function isPublicApi(pathname: string, method: string): boolean {
  if (pathname === "/api/auth" || pathname === "/api/logout") return true;
  if (pathname.startsWith("/api/chatbot/")) return true; // conversation state for the Instagram bot
  if (method === "GET") {
    if (pathname === "/api/availability") return true;
    if (pathname === "/api/accommodation") return true;
    if (pathname === "/api/seasonal-pricing") return true;
    if (pathname === "/api/courses" || pathname.startsWith("/api/courses/")) return true;
  }
  if (method === "POST" && pathname === "/api/reservations") return true; // chatbot creates a booking
  return false;
}

async function isAdmin(request: NextRequest): Promise<boolean> {
  const session = request.cookies.get(ADMIN_COOKIE)?.value;
  const expected = await getAdminSessionToken();
  return !!expected && session === expected;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Static files and Next.js internals
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.includes(".")
  ) {
    return NextResponse.next();
  }

  // API: public endpoints for the chatbot, the rest only for the admin
  if (pathname.startsWith("/api/")) {
    if (isPublicApi(pathname, request.method) || (await isAdmin(request))) {
      return NextResponse.next();
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Public pages
  if (pathname === "/chat-demo" || pathname === "/login") {
    return NextResponse.next();
  }

  // Root "/" → public chatbot
  if (pathname === "/") {
    return NextResponse.redirect(new URL("/chat-demo", request.url));
  }

  // Admin pages
  if (await isAdmin(request)) {
    return NextResponse.next();
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("from", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
