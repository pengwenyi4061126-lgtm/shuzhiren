import { databaseHealth } from "@/lib/database";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await databaseHealth());
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}
